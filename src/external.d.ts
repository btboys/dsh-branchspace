// Ambient declarations for dsh runtime packages resolved inside the host
// process at plugin load time (published npm versions lag the installed
// runtime, so we compile against these minimal shapes instead).
declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(options: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: Record<string, unknown>
      render(args: any, value: any): { type: string; text: string }[]
    }
    timeoutMs?: number
    execute(args: any, exec: unknown): Promise<unknown>
  }): unknown
}
