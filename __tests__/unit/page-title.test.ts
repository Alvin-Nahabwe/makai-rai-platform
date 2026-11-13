import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME, pageTitle } from '@/lib/ui/title';

/** Spec 7.5: the browser-tab title of every page is `<thing> · <project or organisation> · MAK-AI RAI Platform`. */
describe('pageTitle', () => {
  it('1A spec 7.5: a project page reads thing, project, product', () => {
    expect(pageTitle('Findings', 'Antenatal Risk Triage Model')).toBe('Findings · Antenatal Risk Triage Model · MAK-AI RAI Platform');
  });

  it('1A spec 7.5: a page with no context reads thing, product', () => {
    expect(pageTitle('About')).toBe('About · MAK-AI RAI Platform');
  });

  it('1A spec 7.5: an empty or null context is dropped', () => {
    for (const context of [null, undefined, '', '   ']) expect(pageTitle('Members', context)).toBe('Members · MAK-AI RAI Platform');
  });

  it('1A spec 7.5: the product name is the one constant', () => {
    expect(PRODUCT_NAME).toBe('MAK-AI RAI Platform');
    expect(pageTitle('Home', 'Acme').endsWith(` · ${PRODUCT_NAME}`)).toBe(true);
  });
});
