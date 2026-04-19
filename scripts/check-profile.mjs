import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';

const db = new Database(join(homedir(), '.openzigs', 'openzigs.db'));

// Get F5-TTS profile clips
const profileId = 'PkxatgMvckn8kqYu4aHhF';
const clips = db.prepare('SELECT emotion, ref_audio_path, ref_text FROM f5tts_clips WHERE profile_id = ? ORDER BY sort_order ASC').all(profileId);
console.log('F5-TTS clips:', clips.length);
console.log(JSON.stringify(clips, null, 2));

db.close();
