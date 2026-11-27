import { Readable } from 'stream';

// An uploaded file from multer's in-memory storage (only the fields we use; nothing is written to disk)
export interface UploadedAudioFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface VoiceAiUploads {
  audio?: UploadedAudioFile[];
  voice_sample?: UploadedAudioFile[];
}

// GET /health on the Python service
export interface VoiceAiHealth {
  status: string;
  whisper?: boolean;
  llama?: boolean;
  xtts?: boolean;
}

export interface VoiceAiAudio {
  stream: Readable;
  contentType: string;
  contentLength?: number;
}
