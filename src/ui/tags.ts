// Setup tag editor: Session, PD array, HTF trend (rule of 4), Confirmation, Zone size, Avg stop,
// Rule followed. Used in the panel (while a ladder is open), the close form and the Journal.

import { EMPTY_TAGS, type SetupTags, TAG_OPTIONS } from '../core/engine';

type ChoiceKey = keyof typeof TAG_OPTIONS;

const FIELDS: ({ key: ChoiceKey; label: string } | { key: 'zonePips' | 'avgStopPips'; label: string; num: true })[] = [
  { key: 'session', label: 'Session' },
  { key: 'pdArray', label: 'PD array' },
  { key: 'htfTrend', label: 'HTF trend (rule of 4)' },
  { key: 'confirmation', label: 'Confirmation' },
  { key: 'zonePips', label: 'Zone size (pips)', num: true },
  { key: 'avgStopPips', label: 'Avg stop (pips)', num: true },
  { key: 'ruleFollowed', label: 'Rule followed' },
];

let uid = 0;

export class TagEditor {
  readonly root = document.createElement('div');
  private inputs = new Map<keyof SetupTags, HTMLSelectElement | HTMLInputElement>();
  private value: SetupTags;

  constructor(initial: SetupTags | undefined, onChange: (t: SetupTags) => void) {
    this.root.className = 'tag-editor';
    this.value = { ...EMPTY_TAGS, ...initial };
    const n = uid++;
    for (const f of FIELDS) {
      const id = `tag-${n}-${f.key}`;
      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = f.label;
      let input: HTMLSelectElement | HTMLInputElement;
      if ('num' in f) {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.min = '0';
        inp.step = '1';
        inp.placeholder = '-';
        input = inp;
      } else {
        const sel = document.createElement('select');
        sel.append(new Option('-', ''));
        for (const o of TAG_OPTIONS[f.key]) sel.append(new Option(o, o));
        input = sel;
      }
      input.id = id;
      input.addEventListener('change', () => {
        const v = input.value.trim();
        const next = { ...this.value } as Record<string, unknown>;
        next[f.key] = 'num' in f ? (v === '' || !Number.isFinite(Number(v)) ? null : Number(v)) : v;
        this.value = next as unknown as SetupTags;
        onChange(this.value);
      });
      this.inputs.set(f.key, input);
      this.root.append(label, input);
    }
    this.set(this.value);
  }

  /** Shows new values without disturbing a field you are typing in. */
  set(t: SetupTags | undefined) {
    this.value = { ...EMPTY_TAGS, ...t };
    for (const [k, input] of this.inputs) {
      if (document.activeElement === input) continue;
      const v = this.value[k];
      input.value = v === null || v === undefined ? '' : String(v);
    }
  }

  get(): SetupTags {
    return { ...this.value };
  }
}

export function tagSummary(t: SetupTags | undefined): string {
  if (!t) return '';
  const parts = [t.session, t.pdArray, t.htfTrend && `${t.htfTrend} trend`, t.confirmation && `${t.confirmation} conf.`];
  if (t.zonePips !== null) parts.push(`zone ${t.zonePips}p`);
  if (t.avgStopPips !== null) parts.push(`stop ${t.avgStopPips}p`);
  if (t.ruleFollowed) parts.push(`rule ${t.ruleFollowed}`);
  return parts.filter(Boolean).join(' · ');
}

/** Small floating card asking for the setup tags of a closed ladder. Does not pause the replay. */
export function openTagCard(title: string, initial: SetupTags | undefined, onSave: (t: SetupTags) => void): void {
  const card = document.createElement('div');
  card.className = 'tag-card';
  const h = document.createElement('div');
  h.className = 'tag-card-title';
  h.textContent = title;
  let value: SetupTags = { ...EMPTY_TAGS, ...initial };
  const ed = new TagEditor(value, (t) => (value = t));
  const row = document.createElement('div');
  row.className = 'tag-card-buttons';
  const save = document.createElement('button');
  save.className = 'btn primary';
  save.textContent = 'Save tags';
  const skip = document.createElement('button');
  skip.className = 'btn';
  skip.textContent = 'Skip';
  save.onclick = () => {
    onSave(value);
    card.remove();
  };
  skip.onclick = () => card.remove();
  row.append(skip, save);
  card.append(h, ed.root, row);
  document.getElementById('tag-cards')?.append(card);
}
