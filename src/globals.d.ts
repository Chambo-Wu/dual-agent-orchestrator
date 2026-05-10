declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(
    path: string,
    data: string,
    options?: string | { encoding?: string; flag?: string }
  ): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readdirSync(path: string, options?: { withFileTypes?: boolean }): Array<{ name: string }>;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
}

declare module "node:child_process" {
  export function spawnSync(
    command: string,
    args?: string[],
    options?: {
      cwd?: string;
      encoding?: string;
      timeout?: number;
      shell?: boolean;
    }
  ): {
    stdout?: string;
    stderr?: string;
    status: number | null;
    error?: Error;
  };
}

declare module "node:process" {
  export const argv: string[];
  export let exitCode: number;
  export const env: Record<string, string | undefined>;
}

declare module "node:http" {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    on(event: "data", listener: (chunk: string | Uint8Array) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    write(chunk: string): void;
    end(chunk?: string): void;
  }

  export function createServer(
    listener: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  ): {
    listen(port: number, hostname: string, callback?: () => void): void;
  };
}
