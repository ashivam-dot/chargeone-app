// Whether the server offers HD voice (/api/config voiceHd). Kept apart from speech.ts so the app shell
// can set it without loading the speech code.
let on = false;

export const setHdVoice = (value: boolean): void => {
  on = value;
};

export const hdVoiceOn = (): boolean => on;
