import { Check } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { api } from '../lib/api.ts';
import { haptic, platform } from '../native/platform.ts';
import { FEEDBACK_CATEGORIES, type FeedbackCategory } from '../shared/contracts.ts';
import { Sheet } from './Sheet.tsx';
import './screens.css';

interface Props {
  signedIn: boolean;
  /** Where it opened from, e.g. "after-trip". */
  screen: string;
  title?: string;
  onClose: () => void;
}

const FACES: Array<[string, string]> = [
  ['😣', 'Very bad'],
  ['🙁', 'Bad'],
  ['😐', 'Okay'],
  ['🙂', 'Good'],
  ['🤩', 'Loved it'],
];

const CATEGORY_LABEL: Record<FeedbackCategory, string> = {
  trip: 'Trip plan',
  chargers: 'Chargers',
  app: 'App',
  car: 'Car connect',
  idea: 'Idea',
  other: 'Other',
};

const APP_VERSION = '1.0.0';
const MAX = 1000;

export function Feedback({ signedIn, screen, title = 'How was ChargeOne?', onClose }: Props) {
  const [rating, setRating] = useState(0);
  const [category, setCategory] = useState<FeedbackCategory>(screen === 'after-trip' ? 'trip' : 'app');
  const [message, setMessage] = useState('');
  const [contactOk, setContactOk] = useState(false);
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!rating) {
      setError('Pick how it went first.');
      return;
    }
    setState('sending');
    setError(null);
    try {
      await api.feedback({ rating, category, message: message.trim(), screen, appVersion: APP_VERSION, platform: platform(), contactOk: signedIn && contactOk });
      void haptic('success');
      setState('sent');
      setTimeout(onClose, 1600);
    } catch (e) {
      setState('idle');
      setError(e instanceof Error ? e.message : 'Could not send. Try again.');
    }
  };

  return (
    <Sheet title={title} onClose={onClose} modal>
      {state === 'sent' ? (
        <div class="feedback__done" role="status">
          <span class="feedback__check">
            <Check size={34} aria-hidden="true" />
          </span>
          <strong>Thank you!</strong>
          <span class="muted">Every message is read. It shapes what we build next.</span>
        </div>
      ) : (
        <>
          <div class="feedback__faces" role="radiogroup" aria-label="Rating">
            {FACES.map(([face, label], i) => (
              <button
                key={label}
                role="radio"
                aria-checked={rating === i + 1}
                aria-label={label}
                class={`feedback__face${rating === i + 1 ? ' is-on' : ''}${rating && rating !== i + 1 ? ' is-dim' : ''}`}
                onClick={() => {
                  void haptic('selection');
                  setRating(i + 1);
                }}
              >
                <span aria-hidden="true">{face}</span>
              </button>
            ))}
          </div>
          <p class="feedback__label muted center">{rating ? FACES[rating - 1][1] : 'Tap a face'}</p>

          <div class="feedback__cats" role="radiogroup" aria-label="About">
            {FEEDBACK_CATEGORIES.map((c) => (
              <button key={c} class="chip" role="radio" aria-checked={c === category} aria-pressed={c === category} onClick={() => setCategory(c)}>
                {CATEGORY_LABEL[c]}
              </button>
            ))}
          </div>

          <label class="field">
            Tell us more (optional)
            <textarea
              class="feedback__text"
              rows={4}
              maxLength={MAX}
              value={message}
              placeholder="What worked, what didn't, what you'd love to see"
              onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)}
            />
            <span class="small muted feedback__count">
              {message.length}/{MAX}
            </span>
          </label>
          {signedIn && (
            <label class="check field">
              <input type="checkbox" checked={contactOk} onChange={(e) => setContactOk((e.target as HTMLInputElement).checked)} />
              You can email me about this
            </label>
          )}
          {error && (
            <p class="notice notice--error" role="alert">
              {error}
            </p>
          )}
          <button class="btn btn--primary btn--block btn--lg" disabled={state === 'sending'} onClick={() => void send()} data-testid="feedback-send">
            {state === 'sending' ? 'Sending…' : 'Send feedback'}
          </button>
        </>
      )}
    </Sheet>
  );
}
