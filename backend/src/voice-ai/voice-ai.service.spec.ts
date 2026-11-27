import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  NotFoundException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VoiceAiService } from './voice-ai.service';
import { UploadedAudioFile } from './interfaces/voice-ai.interfaces';

const BASE_URL = 'https://voice-ai.test';

const WAV_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);

function audioFile(overrides: Partial<UploadedAudioFile> = {}): UploadedAudioFile {
  return {
    fieldname: 'audio',
    originalname: 'clip.wav',
    mimetype: 'audio/wav',
    size: WAV_BYTES.length,
    buffer: WAV_BYTES,
    ...overrides,
  };
}

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('VoiceAiService', () => {
  let service: VoiceAiService;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    process.env.VOICE_AI_BASE_URL = `${BASE_URL}/`;
    delete process.env.VOICE_AI_API_KEY;
    delete process.env.VOICE_AI_VOICE_SAMPLE_PATH;
    service = new VoiceAiService();
    fetchMock = jest.spyOn(global, 'fetch');
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('checkHealth', () => {
    it('returns the Python service health', async () => {
      fetchMock.mockResolvedValue(json({ status: 'healthy', whisper: true, llama: true, xtts: true }));

      await expect(service.checkHealth()).resolves.toEqual({
        status: 'healthy',
        whisper: true,
        llama: true,
        xtts: true,
      });
      expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/health`, expect.objectContaining({ method: 'GET' }));
    });

    it('throws 503 when the service is unreachable', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      await expect(service.checkHealth()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('throws 504 on timeout', async () => {
      fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
      await expect(service.checkHealth()).rejects.toBeInstanceOf(GatewayTimeoutException);
    });

    it('throws 503 when the ngrok tunnel is offline', async () => {
      fetchMock.mockResolvedValue(
        new Response('<html>offline</html>', { status: 404, headers: { 'ngrok-error-code': 'ERR_NGROK_3200' } }),
      );
      await expect(service.checkHealth()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('throws 503 when the service reports an error status', async () => {
      fetchMock.mockResolvedValue(json({ detail: 'models not loaded' }, 500));
      await expect(service.checkHealth()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('throws 502 on an invalid response', async () => {
      fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
      await expect(service.checkHealth()).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('throws 503 when VOICE_AI_BASE_URL is not set', async () => {
      delete process.env.VOICE_AI_BASE_URL;
      await expect(service.checkHealth()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('processVoice', () => {
    it('forwards both files and the language as multipart and returns the JSON', async () => {
      process.env.VOICE_AI_API_KEY = 'secret';
      fetchMock.mockResolvedValue(json({ request_id: 'abc123', response_text: 'Hello' }));

      const result = await service.processVoice(audioFile(), audioFile({ originalname: 'voice.wav' }), 'hi');

      expect(result).toEqual({ request_id: 'abc123', response_text: 'Hello' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/v1/voice/process`);
      expect(init.method).toBe('POST');
      expect(init.headers['X-API-Key']).toBe('secret');
      const form = init.body as FormData;
      expect((form.get('audio') as File).name).toBe('clip.wav');
      expect((form.get('voice_sample') as File).name).toBe('voice.wav');
      expect(Buffer.from(await (form.get('audio') as File).arrayBuffer())).toEqual(WAV_BYTES);
      expect(form.get('language')).toBe('hi');
    });

    it('rejects a missing audio file without calling the service', async () => {
      await expect(service.processVoice(undefined, audioFile())).rejects.toBeInstanceOf(BadRequestException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a missing voice sample without calling the service', async () => {
      await expect(service.processVoice(audioFile(), undefined)).rejects.toBeInstanceOf(BadRequestException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    describe('with a server-side voice sample (VOICE_AI_VOICE_SAMPLE_PATH)', () => {
      let dir: string;

      beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'voice-ai-'));
      });
      afterEach(() => rmSync(dir, { recursive: true, force: true }));

      it('uses it when the request has no voice sample', async () => {
        const samplePath = join(dir, 'authorised-voice.wav');
        writeFileSync(samplePath, WAV_BYTES);
        process.env.VOICE_AI_VOICE_SAMPLE_PATH = samplePath;
        fetchMock.mockResolvedValue(json({ request_id: 'r-default' }));

        await expect(service.processVoice(audioFile(), undefined)).resolves.toEqual({ request_id: 'r-default' });

        const sample = (fetchMock.mock.calls[0][1].body as FormData).get('voice_sample') as File;
        expect(sample.name).toBe('authorised-voice.wav');
        expect(sample.type).toBe('audio/wav');
        expect(Buffer.from(await sample.arrayBuffer())).toEqual(WAV_BYTES);
      });

      it('prefers an uploaded voice sample', async () => {
        const samplePath = join(dir, 'authorised-voice.wav');
        writeFileSync(samplePath, WAV_BYTES);
        process.env.VOICE_AI_VOICE_SAMPLE_PATH = samplePath;
        fetchMock.mockResolvedValue(json({ request_id: 'r-upload' }));

        await service.processVoice(audioFile(), audioFile({ originalname: 'uploaded.wav' }));

        const sample = (fetchMock.mock.calls[0][1].body as FormData).get('voice_sample') as File;
        expect(sample.name).toBe('uploaded.wav');
      });

      it('throws 503 when the configured file cannot be read', async () => {
        process.env.VOICE_AI_VOICE_SAMPLE_PATH = join(dir, 'missing.wav');
        await expect(service.processVoice(audioFile(), undefined)).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('rejects a configured file that is not audio with 415', async () => {
        const samplePath = join(dir, 'notes.txt');
        writeFileSync(samplePath, 'definitely not an audio file');
        process.env.VOICE_AI_VOICE_SAMPLE_PATH = samplePath;
        await expect(service.processVoice(audioFile(), undefined)).rejects.toBeInstanceOf(
          UnsupportedMediaTypeException,
        );
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });

    it('rejects an unsupported MIME type', async () => {
      await expect(service.processVoice(audioFile({ mimetype: 'image/png' }), audioFile())).rejects.toBeInstanceOf(
        UnsupportedMediaTypeException,
      );
    });

    it('rejects a file whose content is not audio even if the MIME type says it is', async () => {
      const fake = Buffer.from('this is definitely not audio data');
      await expect(
        service.processVoice(audioFile({ buffer: fake, size: fake.length }), audioFile()),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts a real WAV labelled audio/wav', async () => {
      fetchMock.mockResolvedValue(json({ request_id: 'r-wav' }));
      await expect(service.processVoice(audioFile({ mimetype: 'audio/wav' }), audioFile())).resolves.toEqual({
        request_id: 'r-wav',
      });
    });

    it('accepts a real WAV labelled application/octet-stream (curl.exe default)', async () => {
      fetchMock.mockResolvedValue(json({ request_id: 'r0' }));
      await expect(
        service.processVoice(audioFile({ mimetype: 'application/octet-stream' }), audioFile()),
      ).resolves.toEqual({ request_id: 'r0' });
    });

    it('rejects non-audio content labelled application/octet-stream', async () => {
      const fake = Buffer.from('MZ\x90\x00 an executable, not audio');
      await expect(
        service.processVoice(
          audioFile({ mimetype: 'application/octet-stream', buffer: fake, size: fake.length }),
          audioFile(),
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts browser MediaRecorder WebM with a codecs parameter', async () => {
      const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]);
      fetchMock.mockResolvedValue(json({ request_id: 'r1' }));
      await expect(
        service.processVoice(
          audioFile({ mimetype: 'audio/webm;codecs=opus', buffer: webm, size: webm.length }),
          audioFile(),
        ),
      ).resolves.toEqual({ request_id: 'r1' });
    });

    it('maps a Python validation error to 400', async () => {
      fetchMock.mockResolvedValue(json({ detail: [{ msg: 'bad audio' }] }, 422));
      await expect(service.processVoice(audioFile(), audioFile())).rejects.toBeInstanceOf(BadRequestException);
    });

    it('maps an AI processing failure to 502', async () => {
      fetchMock.mockResolvedValue(json({ detail: 'CUDA out of memory' }, 500));
      await expect(service.processVoice(audioFile(), audioFile())).rejects.toBeInstanceOf(BadGatewayException);
    });

    it.each([
      ['No speech detected', BadRequestException],
      ['Unsupported language', BadRequestException],
      ['Voice processing failed', BadGatewayException],
    ])('maps the Python 200 {"error": %p} reply to the right error', async (error, expected) => {
      fetchMock.mockResolvedValue(json({ error }));
      await expect(service.processVoice(audioFile(), audioFile())).rejects.toBeInstanceOf(expected);
    });

    it('throws 504 when processing times out', async () => {
      fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
      await expect(service.processVoice(audioFile(), audioFile())).rejects.toBeInstanceOf(GatewayTimeoutException);
    });

    it('throws 503 when the service is unavailable', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      await expect(service.processVoice(audioFile(), audioFile())).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('transcribe (Colab-voiced calls)', () => {
    it('sends the WAV and returns the text', async () => {
      fetchMock.mockResolvedValue(json({ text: ' Yes, book 10:30 please ' }));

      await expect(service.transcribe(WAV_BYTES)).resolves.toBe(' Yes, book 10:30 please ');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/v1/voice/transcribe`);
      const audio = (init.body as FormData).get('audio') as File;
      expect(audio.type).toBe('audio/wav');
      expect(Buffer.from(await audio.arrayBuffer())).toEqual(WAV_BYTES);
    });

    it('throws 503 with a clear message when the notebook lacks the endpoint', async () => {
      fetchMock.mockResolvedValue(json({ detail: 'Not Found' }, 404));
      await expect(service.transcribe(WAV_BYTES)).rejects.toThrow(/transcribe and \/speak endpoints/);
    });

    it('throws 502 when Whisper fails', async () => {
      fetchMock.mockResolvedValue(json({ error: 'Transcription failed' }, 500));
      await expect(service.transcribe(WAV_BYTES)).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  describe('speak (Colab-voiced calls)', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'voice-ai-'));
      process.env.VOICE_AI_VOICE_SAMPLE_PATH = join(dir, 'authorised-voice.wav');
      writeFileSync(process.env.VOICE_AI_VOICE_SAMPLE_PATH, WAV_BYTES);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('sends text, language and the server-side voice sample, and returns the WAV', async () => {
      fetchMock.mockResolvedValue(new Response(WAV_BYTES, { status: 200, headers: { 'content-type': 'audio/wav' } }));

      await expect(service.speak('Your appointment is booked.', 'hi')).resolves.toEqual(WAV_BYTES);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/v1/voice/speak`);
      const form = init.body as FormData;
      expect(form.get('text')).toBe('Your appointment is booked.');
      expect(form.get('language')).toBe('hi');
      expect((form.get('voice_sample') as File).name).toBe('authorised-voice.wav');
    });

    it('throws 503 when no voice sample is configured', async () => {
      delete process.env.VOICE_AI_VOICE_SAMPLE_PATH;
      await expect(service.speak('Hello')).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws 502 when XTTS returns an error instead of audio', async () => {
      fetchMock.mockResolvedValue(json({ error: 'Speech generation failed' }, 500));
      await expect(service.speak('Hello')).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  describe('getAudio', () => {
    it('streams the generated audio with its content type', async () => {
      fetchMock.mockResolvedValue(new Response(WAV_BYTES, { status: 200, headers: { 'content-type': 'audio/wav' } }));

      const audio = await service.getAudio('abc-123_x');

      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/voice/audio/abc-123_x`);
      expect(audio.contentType).toBe('audio/wav');
      const chunks: Buffer[] = [];
      for await (const chunk of audio.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(WAV_BYTES);
    });

    it.each(['../health', 'a/b', 'abc?x=1', '', 'x'.repeat(65)])(
      'rejects invalid request ID %p without calling the service',
      async (id) => {
        await expect(service.getAudio(id)).rejects.toBeInstanceOf(BadRequestException);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('throws 404 when the audio does not exist', async () => {
      fetchMock.mockResolvedValue(json({ detail: 'Not found' }, 404));
      await expect(service.getAudio('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws 404 when the service reports a missing ID as 200 {"error": "Audio not found"}', async () => {
      fetchMock.mockResolvedValue(json({ error: 'Audio not found' }));
      await expect(service.getAudio('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws 502 when the service returns something other than audio', async () => {
      fetchMock.mockResolvedValue(json({ error: 'TTS failed' }));
      await expect(service.getAudio('abc')).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('throws 502 when audio generation fails', async () => {
      fetchMock.mockResolvedValue(json({ detail: 'XTTS error' }, 500));
      await expect(service.getAudio('abc')).rejects.toBeInstanceOf(BadGatewayException);
    });
  });
});
