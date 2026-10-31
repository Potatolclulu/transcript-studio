import type { Transcript } from './model';
export const SAMPLE_TITLE = 'A small practice for better listening';
export const SAMPLE: Transcript = {
  title: SAMPLE_TITLE, language: 'en', source: 'sample', timed: true,
  text: '', segments: [
    { start: 0, end: 7.8, text: 'There is a small difference between hearing someone and making room for what they are saying.' },
    { start: 8, end: 16.6, text: 'When we listen, we often start writing our reply before the other person has finished their thought.' },
    { start: 17, end: 25.4, text: 'Try leaving a little space. One breath is enough. Let the last sentence settle before you add your own.' },
    { start: 26, end: 35.2, text: 'You may notice something you missed: a hesitation, a change in emphasis, or a question underneath the words.' },
    { start: 36, end: 45.5, text: 'Then ask a simple question. What do you mean by that? Or, what happened next? Curiosity works better than a prepared answer.' },
    { start: 46, end: 56.2, text: 'Good listening is not a performance. It is a practice of attention, repeated in ordinary conversations, one moment at a time.' },
  ],
};
SAMPLE.text = SAMPLE.segments.map(s => s.text).join('\n\n');
