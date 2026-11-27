// Colab call mode: mic PCM → turn detection → Whisper (mocked) → Groq + tools (fetch mocked) → XTTS (mocked)
import { ServiceUnavailableException } from '@nestjs/common';
import { VoiceCallbacks, VoiceService } from './voice.service';

const flush = () => new Promise((r) => setTimeout(r, 0));

// 20 ms of 16 kHz PCM16, loud or silent
const chunk = (loud: boolean) => {
  const buf = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) buf.writeInt16LE(loud ? (i % 2 ? 8000 : -8000) : 0, i * 2);
  return buf;
};

const groqReply = (message: any) =>
  new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('VoiceService — Colab mode', () => {
  const REPLY_WAV = Buffer.from('RIFF....WAVEreply');
  let voiceAi: { transcribe: jest.Mock; speak: jest.Mock };
  let clinic: { bookAppointment: jest.Mock; getFreeSlots: jest.Mock };
  let callbacks: { [K in keyof VoiceCallbacks]: jest.Mock };
  let service: VoiceService;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key';
    voiceAi = { transcribe: jest.fn(), speak: jest.fn().mockResolvedValue(REPLY_WAV) };
    clinic = {
      bookAppointment: jest.fn().mockReturnValue({ success: true, message: 'Booked' }),
      getFreeSlots: jest.fn().mockReturnValue([]),
    };
    callbacks = {
      onAudio: jest.fn(),
      onTranscript: jest.fn(),
      onStatus: jest.fn(),
      onToolAction: jest.fn(),
      onError: jest.fn(),
    };
    service = new VoiceService(clinic as any, voiceAi as any);
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn((service as any).logger, level).mockImplementation(() => undefined);
    }
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  it('greets the customer in the Colab voice when the call is answered', async () => {
    fetchMock.mockResolvedValue(groqReply({ content: 'Hello, this is City Care Clinic.' }));

    service.startSession('s1', 'system prompt', callbacks, 'colab');
    service.answerCall('s1');
    await flush();

    expect(voiceAi.speak).toHaveBeenCalledWith('Hello, this is City Care Clinic.', 'en');
    expect(callbacks.onTranscript).toHaveBeenCalledWith('agent', 'Hello, this is City Care Clinic.');
    expect(callbacks.onAudio).toHaveBeenCalledWith(REPLY_WAV);
    expect(callbacks.onStatus).toHaveBeenLastCalledWith('listening');
  });

  it('turns a spoken turn into a WAV for Whisper, runs the booking tool, and speaks the reply', async () => {
    fetchMock.mockResolvedValueOnce(groqReply({ content: 'Hello.' }));
    service.startSession('s1', 'system prompt', callbacks, 'colab');
    service.answerCall('s1');
    await flush();

    voiceAi.transcribe.mockResolvedValue('Yes, book slot two please');
    fetchMock
      .mockResolvedValueOnce(
        groqReply({
          content: '',
          tool_calls: [
            {
              id: 't1',
              function: { name: 'book_appointment', arguments: '{"appointmentId":"APT003","slotId":"SLOT002"}' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(groqReply({ content: 'Done, you are booked.' }));

    for (let i = 0; i < 25; i++) service.sendAudio('s1', chunk(true)); // 500 ms of speech while talking
    service.endColabTurn('s1'); // talk button released
    await flush();

    const wav: Buffer = voiceAi.transcribe.mock.calls[0][0];
    expect(wav.toString('latin1', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(callbacks.onTranscript).toHaveBeenCalledWith('customer', 'Yes, book slot two please');
    expect(clinic.bookAppointment).toHaveBeenCalledWith('APT003', 'SLOT002');
    expect(callbacks.onToolAction).toHaveBeenCalledWith(
      'book_appointment',
      { appointmentId: 'APT003', slotId: 'SLOT002' },
      { success: true, message: 'Booked' },
    );
    expect(voiceAi.speak).toHaveBeenLastCalledWith('Done, you are booked.', 'en');
  });

  it.each([
    ['a mis-tap (100 ms)', () => Array.from({ length: 5 }, () => chunk(true))],
    ['a silent turn (1 s)', () => Array.from({ length: 50 }, () => chunk(false))],
  ])('does not send %s to Whisper', async (_label, chunks) => {
    fetchMock.mockResolvedValue(groqReply({ content: 'Hello.' }));
    service.startSession('s1', 'system prompt', callbacks, 'colab');
    service.answerCall('s1');
    await flush();

    for (const c of chunks()) service.sendAudio('s1', c);
    service.endColabTurn('s1');
    await flush();

    expect(voiceAi.transcribe).not.toHaveBeenCalled();
    expect(callbacks.onStatus).toHaveBeenLastCalledWith('nothing-heard');
  });

  it('ignores mic audio while the agent is still thinking', async () => {
    let finishGreeting: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => (finishGreeting = r)));
    service.startSession('s1', 'system prompt', callbacks, 'colab');
    service.answerCall('s1');

    for (let i = 0; i < 25; i++) service.sendAudio('s1', chunk(true));
    finishGreeting!(groqReply({ content: 'Hello.' }));
    await flush();
    service.endColabTurn('s1');
    await flush();

    expect(voiceAi.transcribe).not.toHaveBeenCalled();
  });

  it('speaks Hindi replies with the Hindi XTTS voice', async () => {
    fetchMock.mockResolvedValue(groqReply({ content: 'नमस्ते, मैं सिटी केयर क्लिनिक से बोल रही हूँ।' }));
    service.startSession('s1', 'system prompt', callbacks, 'colab');
    service.answerCall('s1');
    await flush();

    expect(voiceAi.speak).toHaveBeenCalledWith(expect.any(String), 'hi');
  });

  it('ends the call with a readable error when Colab is unreachable', async () => {
    fetchMock.mockResolvedValue(groqReply({ content: 'Hello.' }));
    voiceAi.speak.mockRejectedValue(new ServiceUnavailableException('Voice AI service is unavailable.'));

    service.startSession('s1', 'system prompt', callbacks, 'colab');
    service.answerCall('s1');
    await flush();

    expect(callbacks.onError).toHaveBeenCalledWith('Voice AI service is unavailable.');
  });
});
