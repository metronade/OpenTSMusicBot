'use strict';

// Single source of truth for all Piper TTS voices.
// Each entry: { id, label, language, langLabel, modelFile, quality, multiSpeaker?, speakerId? }

const VOICES = [
  // ── German ──────────────────────────────────────────────────────────────────
  {
    id: 'thorsten',
    label: 'Thorsten',
    language: 'de',
    langLabel: 'Deutsch',
    modelFile: 'de_DE-thorsten-medium.onnx',
    quality: 'medium',
  },
  {
    id: 'kerstin',
    label: 'Kerstin',
    language: 'de',
    langLabel: 'Deutsch',
    modelFile: 'de_DE-kerstin-low.onnx',
    quality: 'low',
  },

  // ── German – Thorsten Emotional (single multi-speaker model) ────────────────
  {
    id: 'thorsten_angry',
    label: 'Thorsten (Angry)',
    language: 'de',
    langLabel: 'Deutsch',
    modelFile: 'de_DE-thorsten_emotional-medium.onnx',
    quality: 'medium',
    multiSpeaker: true,
    speakerId: 0,
  },
  {
    id: 'thorsten_disgusted',
    label: 'Thorsten (Disgusted)',
    language: 'de',
    langLabel: 'Deutsch',
    modelFile: 'de_DE-thorsten_emotional-medium.onnx',
    quality: 'medium',
    multiSpeaker: true,
    speakerId: 1,
  },
  {
    id: 'thorsten_drunk',
    label: 'Thorsten (Drunk)',
    language: 'de',
    langLabel: 'Deutsch',
    modelFile: 'de_DE-thorsten_emotional-medium.onnx',
    quality: 'medium',
    multiSpeaker: true,
    speakerId: 2,
  },
  {
    id: 'thorsten_sleepy',
    label: 'Thorsten (Sleepy)',
    language: 'de',
    langLabel: 'Deutsch',
    modelFile: 'de_DE-thorsten_emotional-medium.onnx',
    quality: 'medium',
    multiSpeaker: true,
    speakerId: 3,
  },
  {
    id: 'thorsten_whisper',
    label: 'Thorsten (Whisper)',
    language: 'de',
    langLabel: 'Deutsch',
    modelFile: 'de_DE-thorsten_emotional-medium.onnx',
    quality: 'medium',
    multiSpeaker: true,
    speakerId: 4,
  },

  // ── English ─────────────────────────────────────────────────────────────────
  {
    id: 'alba',
    label: 'Alba',
    language: 'en',
    langLabel: 'English',
    modelFile: 'en_GB-alba-medium.onnx',
    quality: 'medium',
  },
  {
    id: 'cori',
    label: 'Cori',
    language: 'en',
    langLabel: 'English',
    modelFile: 'en_GB-cori-medium.onnx',
    quality: 'medium',
  },
  {
    id: 'northern_english_male',
    label: 'Northern English Male',
    language: 'en',
    langLabel: 'English',
    modelFile: 'en_GB-northern_english_male-medium.onnx',
    quality: 'medium',
  },
];

const _byId = new Map(VOICES.map(v => [v.id, v]));

function getVoice(id) {
  return _byId.get(id) || null;
}

function getAllVoiceIds() {
  return VOICES.map(v => v.id);
}

function voicesByLanguage() {
  const groups = new Map();
  for (const v of VOICES) {
    if (!groups.has(v.language)) groups.set(v.language, []);
    groups.get(v.language).push(v);
  }
  return groups;
}

module.exports = { VOICES, getVoice, getAllVoiceIds, voicesByLanguage };
