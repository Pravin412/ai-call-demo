// HTTP-level tests: real controller, multer and ValidationPipe; only the Python service (fetch) is mocked.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { VoiceAiModule } from './voice-ai.module';
import { VoiceAiService, MAX_UPLOAD_BYTES } from './voice-ai.service';

const WAV_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);

const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('VoiceAiController', () => {
  let app: INestApplication;
  let fetchMock: jest.SpyInstance;

  beforeAll(async () => {
    process.env.VOICE_AI_BASE_URL = 'https://voice-ai.test';
    delete process.env.VOICE_AI_VOICE_SAMPLE_PATH;
    const moduleRef = await Test.createTestingModule({ imports: [VoiceAiModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true })); // same as main.ts
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    const logger = (app.get(VoiceAiService) as any).logger;
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('GET /health returns the service health', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'healthy' }), { status: 200 }));
    await request(app.getHttpServer()).get('/api/v1/voice-ai/health').expect(200, { status: 'healthy' });
  });

  it('GET /health returns 503 without leaking internals when the service is down', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await request(app.getHttpServer()).get('/api/v1/voice-ai/health').expect(503);
    expect(res.body.message).toBe('Voice AI service is unavailable.');
    expect(JSON.stringify(res.body)).not.toContain('voice-ai.test');
  });

  it('POST /process forwards the upload and returns the JSON', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ request_id: 'abc123' }), { status: 200 }));
    await request(app.getHttpServer())
      .post('/api/v1/voice-ai/process')
      .attach('audio', WAV_BYTES, { filename: 'clip.wav', contentType: 'audio/wav' })
      .attach('voice_sample', WAV_BYTES, { filename: 'voice.wav', contentType: 'audio/wav' })
      .field('language', 'en')
      .expect(200, { request_id: 'abc123' });
  });

  it('POST /process returns 400 when the voice sample is missing', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/voice-ai/process')
      .attach('audio', WAV_BYTES, { filename: 'clip.wav', contentType: 'audio/wav' })
      .expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /process returns 400 for an unsupported language', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/voice-ai/process')
      .attach('audio', WAV_BYTES, { filename: 'clip.wav', contentType: 'audio/wav' })
      .attach('voice_sample', WAV_BYTES, { filename: 'voice.wav', contentType: 'audio/wav' })
      .field('language', 'klingon')
      .expect(400);
  });

  it('POST /process returns 415 for an unsupported file type', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/voice-ai/process')
      .attach('audio', Buffer.from('%PDF-1.7 not audio at all'), { filename: 'x.pdf', contentType: 'application/pdf' })
      .attach('voice_sample', WAV_BYTES, { filename: 'voice.wav', contentType: 'audio/wav' })
      .expect(415);
  });

  it('POST /process returns 413 for a file over the size limit', async () => {
    const big = Buffer.concat([WAV_BYTES, Buffer.alloc(MAX_UPLOAD_BYTES)]);
    await request(app.getHttpServer())
      .post('/api/v1/voice-ai/process')
      .attach('audio', big, { filename: 'big.wav', contentType: 'audio/wav' })
      .attach('voice_sample', WAV_BYTES, { filename: 'voice.wav', contentType: 'audio/wav' })
      .expect(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /audio/:requestId streams the audio with its content type', async () => {
    fetchMock.mockResolvedValue(new Response(WAV_BYTES, { status: 200, headers: { 'content-type': 'audio/wav' } }));
    const res = await request(app.getHttpServer())
      .get('/api/v1/voice-ai/audio/abc123')
      .buffer(true)
      .parse(binary)
      .expect(200)
      .expect('content-type', 'audio/wav');
    expect(res.body).toEqual(WAV_BYTES);
  });

  it('GET /audio/:requestId returns 400 for an invalid request ID', async () => {
    await request(app.getHttpServer()).get('/api/v1/voice-ai/audio/bad%2E%2E%2Fid').expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /audio/:requestId returns 404 when the audio is missing', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: 'Not found' }), { status: 404 }));
    await request(app.getHttpServer()).get('/api/v1/voice-ai/audio/missing').expect(404);
  });
});
