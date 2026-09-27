// Desktop sign-in loads node:http lazily; phones never do. This subset lets
// tsconfig.src.json check src without Node globals such as Buffer or process.
declare module 'node:http' {
    interface IncomingMessage { url?: string; method?: string }
    interface ServerResponse {
        writeHead(status: number, headers?: Record<string, string>): ServerResponse;
        end(body?: string): void;
    }
    interface Server {
        listen(port: number, host: string, callback: () => void): void;
        once(event: 'error', listener: (error: Error) => void): void;
        on(event: 'request', listener: (request: IncomingMessage, response: ServerResponse) => void): void;
        address(): { port: number } | string | null;
        close(): void;
    }
    function createServer(): Server;
}
