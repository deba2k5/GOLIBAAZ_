import type { Server } from 'node:http';

export function attachRelay(httpServer: Server, path?: string): unknown;
