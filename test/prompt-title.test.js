import assert from 'node:assert/strict';
import test from 'node:test';

import { derivePromptTitle } from '../public/prompt-title.js';

test('distills an English request into its primary task', () => {
  assert.equal(
    derivePromptTitle('Could you please help me fix the login redirect loop when the token expires and add regression tests?'),
    'Fix the login redirect loop',
  );
});

test('distills a Thai request into its primary task', () => {
  assert.equal(
    derivePromptTitle('รบกวนช่วยแก้ปัญหาหน้า login ที่ redirect วนเมื่อ token หมดอายุ และเพิ่ม test ให้หน่อยครับ'),
    'แก้ปัญหาหน้า login ที่ redirect วน',
  );
});

test('keeps concise Thai and English task titles intact', () => {
  assert.equal(derivePromptTitle('Add dark mode to the settings page'), 'Add dark mode to the settings page');
  assert.equal(derivePromptTitle('เพิ่ม dark mode ในหน้าตั้งค่า'), 'เพิ่ม dark mode ในหน้าตั้งค่า');
});

test('keeps a shared object joined by Thai or English conjunctions', () => {
  assert.equal(derivePromptTitle('Add dark mode and keyboard shortcuts'), 'Add dark mode and keyboard shortcuts');
  assert.equal(derivePromptTitle('เพิ่ม dark mode และ keyboard shortcuts'), 'เพิ่ม dark mode และ keyboard shortcuts');
});

test('selects a task after introductory context', () => {
  assert.equal(
    derivePromptTitle('The settings page is difficult to use. Please simplify the account form and add tests.'),
    'Simplify the account form',
  );
  assert.equal(
    derivePromptTitle('หน้าตั้งค่าใช้งานยากมาก\nอยากให้ช่วยปรับฟอร์มบัญชีให้เรียบง่าย และเพิ่ม test'),
    'ปรับฟอร์มบัญชีให้เรียบง่าย',
  );
});

test('removes terminal and markdown prompt decoration', () => {
  assert.equal(
    derivePromptTitle('\x1b[32m❯\x1b[0m ## Please review the billing API, thanks'),
    'Review the billing API',
  );
});

test('limits long titles without splitting a Unicode grapheme', () => {
  const title = derivePromptTitle(`สร้าง${'ฟีเจอร์ใหม่'.repeat(12)}`);
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(title)];

  assert.ok(graphemes.length <= 64);
  assert.match(title, /…$/u);
  assert.doesNotMatch(title, /^[\p{M}]/u);
});

test('returns an empty title for a prompt with no meaningful text', () => {
  assert.equal(derivePromptTitle('\x1b[31m>\x1b[0m   '), '');
});

test('does not use slash commands as automatic chat titles', () => {
  assert.equal(derivePromptTitle('/plan improve the account settings'), '');
  assert.equal(derivePromptTitle('/always-approve'), '');
  assert.equal(derivePromptTitle('\x1b[32m❯\x1b[0m /goal ship the release'), '');
  assert.equal(derivePromptTitle('Use /plan when you are ready'), 'Use /plan');
  assert.equal(derivePromptTitle('/Users/sirawat/project needs cleanup'), '/Users/sirawat/project needs cleanup');
});
