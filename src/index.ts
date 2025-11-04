import { Context, Schema } from 'koishi'
import { readFile, access, stat } from 'fs/promises'
import { dirname } from 'path'

export const name = 'aka-abioticfactor-servercode'

export interface Config {
  logPath: string
  enableLog: boolean
}

export const Config: Schema<Config> = Schema.object({
  logPath: Schema.string().required().description('日志文件路径（例如：/mnt/user/appdata/abioticfactor/AbioticFactor/Saved/Logs/AbioticFactor.log）'),
  enableLog: Schema.boolean().default(true).description('启用日志记录')
})

// 延迟函数
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 读取日志文件（带重试机制，适用于网络文件系统）
async function readLogFile(logPath: string, maxRetries: number = 3): Promise<string> {
  let lastError: any = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 直接尝试读取文件，不先检查 access（避免网络文件系统的 access 问题）
      const fileContent = await readFile(logPath, 'utf-8')
      return fileContent
    } catch (error: any) {
      lastError = error

      // 如果是网络文件系统错误（-116），尝试重试
      if (error.errno === -116 || error.code === 'Unknown system error -116') {
        if (attempt < maxRetries) {
          const waitTime = attempt * 500 // 递增等待时间：500ms, 1000ms, 1500ms
          await delay(waitTime)
          continue
        }
        throw new Error(`网络文件系统访问失败（错误 -116），已重试 ${maxRetries} 次。可能是 Unraid 网络存储连接问题，请检查网络存储状态或稍后重试`)
      }

      // 如果文件不存在，尝试检查父目录
      if (error.code === 'ENOENT') {
        const parentDir = dirname(logPath)
        try {
          const parentStat = await stat(parentDir)
          if (parentStat.isDirectory()) {
            throw new Error(`文件不存在，但目录存在。请检查文件名是否正确: ${logPath}`)
          }
        } catch (parentError: any) {
          if (parentError.code === 'ENOENT' || parentError.errno === -116) {
            throw new Error(`路径不存在或无法访问。请确保容器已挂载该目录: ${logPath}\n提示: 在 Unraid 中，需要在容器配置中挂载目录，例如将 /mnt/user/appdata/abioticfactor 挂载到容器的 /appdata/abioticfactor`)
          }
          throw error
        }
        throw error
      }

      // 其他错误直接抛出
      throw error
    }
  }

  throw lastError
}

// 从日志内容中提取短代码
function extractShortCode(logContent: string): string[] {
  // 匹配格式: [2025.11.04-10.17.29:161][  1]LogAbiotic: Warning: Session short code: 78B37
  const regex = /LogAbiotic: Warning: Session short code: (\w+)/g
  const matches: string[] = []
  let match

  while ((match = regex.exec(logContent)) !== null) {
    matches.push(match[1])
  }

  return matches
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('aka-abioticfactor-servercode')

  ctx.command('服务器代码', '获取 Abiotic Factor 服务器短代码')
    .action(async ({ session }) => {
      if (!config.logPath) {
        return '错误: 插件配置中未设置日志文件路径，请在插件设置页面配置'
      }

      try {
        if (config.enableLog) {
          logger.info(`用户 ${session.userId} 查询服务器短代码`)
        }

        // 读取日志文件
        const logContent = await readLogFile(config.logPath)

        // 提取短代码
        const matches = extractShortCode(logContent)

        if (matches.length === 0) {
          if (config.enableLog) {
            logger.info(`日志文件中未找到短代码`)
          }
          return '未在日志文件中找到短代码'
        }

        // 返回最新的短代码（最后一个匹配的）
        const latestCode = matches[matches.length - 1]
        
        if (config.enableLog) {
          logger.info(`找到短代码: ${latestCode} (共 ${matches.length} 个匹配)`)
        }

        return `服务器短代码: ${latestCode}`
      } catch (error: any) {
        logger.error(`读取日志文件失败:`, error)

        // 处理常见的错误情况
        if (error.code === 'ENOENT') {
          const errorMsg = error.message || '文件不存在'
          return `错误: ${errorMsg}\n\n请检查：\n1. 路径是否正确\n2. 容器是否已挂载该目录\n3. 在 Unraid 中，确保容器配置中已挂载日志目录`
        }

        if (error.code === 'EACCES' || error.message?.includes('permission denied')) {
          return `错误: 权限不足，无法读取日志文件: ${config.logPath}\n\n请检查文件权限或容器运行用户权限`
        }

        // 处理网络文件系统错误
        if (error.errno === -116 || error.message?.includes('错误 -116') || error.message?.includes('Unknown system error -116')) {
          return `错误: 网络文件系统访问失败\n路径: ${config.logPath}\n\n可能的原因：\n1. Unraid 网络存储连接不稳定\n2. 网络存储响应超时\n3. 文件系统权限问题\n\n建议：\n1. 检查 Unraid 网络存储状态\n2. 稍后重试\n3. 确认挂载路径正确`
        }

        return `错误: 无法读取日志文件\n路径: ${config.logPath}\n详情: ${error.message || '未知错误'}\n错误码: ${error.code || error.errno || '未知'}`
      }
    })
}
