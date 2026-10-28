/**
 * Open a URL in the user's system browser, as the SIWC docs prescribe. The
 * URL is passed as one argv element (no shell), so it cannot inject commands.
 */
import { spawn } from 'node:child_process'

export type OpenBrowser = (url: string) => Promise<void>

export const openSystemBrowser: OpenBrowser = (url) => {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
