import { All, Controller, HttpException, Logger, RawBodyRequest, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ClinicService } from '../clinic/clinic.service';
import { buildManifest } from '../ai-platform/ai-platform.manifest';
import { ClinicToolsService } from '../ai-platform/clinic-tools.service';
import { verifySignature } from '../ai-platform/verify-signature';

// Open idle sessions beyond this are dropped, oldest first, so abandoned clients can't pile up
const MAX_SESSIONS = 100;
const APPLICATION_ID = 'ai-call-demo';
// Voice, time zone and speech hints: only the AI Platform uses them; other clients ignore them
const SETTINGS_URI = 'ai-platform://settings';
// The AI Platform sends its conversation ID here on every tools/call
const SESSION_META_KEY = 'ai-platform/session_id';
// Same format the AI Platform accepts for session IDs
const SESSION_ID = /^[A-Za-z0-9._:+@-]{1,128}$/;

type Caller = 'platform' | 'client';
type Session = { transport: StreamableHTTPServerTransport; caller: Caller };

// MCP server at /mcp (Streamable HTTP). One set of tools for every AI that talks to this clinic:
//  - the AI Platform signs each request with AI_CALL_DEMO_CALLBACK_SECRET (same HMAC as before), and
//    passes its conversation ID in _meta, so caller verification is per conversation;
//  - ChatGPT, Claude, Cursor and other MCP clients send "Authorization: Bearer <MCP_API_KEY>"
//    (with no key set, only the AI Platform can connect); verification is per MCP session.
// Either way nothing about an appointment is shown until the caller passes verify_caller.
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);
  private readonly apiKey = process.env.MCP_API_KEY || '';
  private readonly platformSecret = process.env.AI_CALL_DEMO_CALLBACK_SECRET || '';
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly clinic: ClinicService,
    private readonly tools: ClinicToolsService,
  ) {}

  @All()
  async handle(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    const caller = this.identify(req);
    if (!caller) {
      if (!this.apiKey && !this.platformSecret) return rpcError(res, 404, 'MCP is disabled.');
      return rpcError(res, 401, 'Invalid or missing credentials.');
    }

    const sessionId = req.headers['mcp-session-id'];
    let session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
    // A session belongs to whoever opened it: a public client can't use the platform's, or the reverse
    if (session && session.caller !== caller) session = undefined;
    if (!session) {
      if (sessionId) return rpcError(res, 404, 'Session not found; start a new one.');
      if (req.method !== 'POST') return rpcError(res, 400, 'Start a session with an initialize POST.');
      session = this.newSession(caller);
    }
    await session.transport.handleRequest(req, res, req.body);
  }

  // The AI Platform's HMAC signature, or a public client's bearer key; undefined if neither
  private identify(req: RawBodyRequest<Request>): Caller | undefined {
    const signature = req.headers['x-ai-platform-signature'];
    if (typeof signature === 'string') {
      const ok =
        req.headers['x-ai-platform-application'] === APPLICATION_ID &&
        verifySignature(this.platformSecret, signature, req.rawBody ?? Buffer.alloc(0));
      return ok ? 'platform' : undefined;
    }
    return this.apiKey && safeEqual(bearer(req.headers.authorization), this.apiKey) ? 'client' : undefined;
  }

  private newSession(caller: Caller): Session {
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        if (this.sessions.size >= MAX_SESSIONS) {
          const [oldest] = this.sessions.keys();
          this.sessions.get(oldest)?.transport.close();
          this.sessions.delete(oldest);
        }
        this.sessions.set(id, session);
      },
    });
    const session: Session = { transport, caller };
    transport.onclose = () => transport.sessionId && this.sessions.delete(transport.sessionId);

    const manifest = buildManifest(this.clinic.getClinicInfo());
    const server = new Server(
      { name: 'ai-call-demo-clinic', title: manifest.name, version: '1.0.0' },
      { capabilities: { tools: {}, resources: {} }, instructions: manifest.system_prompt },
    );

    // Tool list comes straight from the manifest, so every client sees the same tools
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: Object.entries(buildManifest(this.clinic.getClinicInfo()).tools).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: {
          type: 'object' as const,
          properties: Object.fromEntries(
            Object.entries(tool.parameters).map(([key, p]) => [
              key,
              {
                type: p.type,
                description: p.description,
                enum: p.enum,
                pattern: p.pattern,
                maxLength: p.max_length,
                minimum: p.minimum,
                maximum: p.maximum,
              },
            ]),
          ),
          required: Object.entries(tool.parameters)
            .filter(([, p]) => p.required !== false)
            .map(([key]) => key),
          additionalProperties: false,
        },
      })),
    }));

    server.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: [
        {
          uri: SETTINGS_URI,
          name: 'ai-platform-settings',
          description: 'Voice, time zone and speech hints for the AI Platform voice agent.',
          mimeType: 'application/json',
        },
      ],
    }));

    server.setRequestHandler(ReadResourceRequestSchema, (request) => {
      if (request.params.uri !== SETTINGS_URI) throw new Error(`Unknown resource ${request.params.uri}`);
      const { name, timezone, voice, speech_language, speech_hints } = buildManifest(this.clinic.getClinicInfo());
      return {
        contents: [
          {
            uri: SETTINGS_URI,
            mimeType: 'application/json',
            text: JSON.stringify({ name, timezone, voice, speech_language, speech_hints }),
          },
        ],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, (request) => {
      let toolSession: string;
      if (caller === 'platform') {
        // One MCP session carries many conversations; each keeps its own verification
        const conversation = request.params._meta?.[SESSION_META_KEY];
        if (typeof conversation !== 'string' || !SESSION_ID.test(conversation)) {
          return { isError: true, content: [{ type: 'text' as const, text: `Missing _meta["${SESSION_META_KEY}"].` }] };
        }
        toolSession = `aip:${conversation}`;
      } else {
        // Prefixed so a public MCP session can never share verification state with the AI Platform
        toolSession = `mcp:${transport.sessionId}`;
      }
      try {
        const result = this.tools.run(request.params.name, request.params.arguments ?? {}, toolSession);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        // Refusals go back to the model as tool errors it can explain
        if (err instanceof HttpException && err.getStatus() < 500) {
          return { isError: true, content: [{ type: 'text' as const, text: err.message }] };
        }
        this.logger.error(`MCP tool ${request.params.name} failed: ${(err as Error)?.message}`);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'The clinic system failed. Try again later.' }],
        };
      }
    });

    server.connect(transport);
    return session;
  }
}

function bearer(header: string | undefined): string {
  return header?.startsWith('Bearer ') ? header.slice(7) : '';
}

function safeEqual(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function rpcError(res: Response, status: number, message: string) {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}
