// The resource links on the 28 controls of content 5.0.0 (CG-03 to CG-09, FR-PUB-03, OD-21).
//
// Content-unit test: it reads data/content/5.0.0/assessmentAreas.json with `fs` and never calls
// `loadContent` on the real bundle. It names no question id, only control ids (00-contract.md,
// "Content bundle", gap G088). It starts, deliberately, before that file can be edited: until the
// 5.0.0 areas file exists every case below fails on ENOENT, and once it exists they fail on the
// links that are still missing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AreasFile } from '@/types/content';
import fixture from '../fixtures/resources/resources-4.0.0.json';
import { MANUAL_CHECK } from '../../scripts/content/check-links.mjs';

type Control = AreasFile['controls'][number];
type Resource = NonNullable<Control['resources']>[number];

const AREAS_FILE = join(process.cwd(), 'data', 'content', '5.0.0', 'assessmentAreas.json');

let cached: AreasFile | undefined;
const controls = (): Control[] => {
  cached ??= JSON.parse(readFileSync(AREAS_FILE, 'utf8')) as AreasFile;
  return cached.controls;
};
const ctl = (id: string): Control => {
  const c = controls().find((x) => x.id === id);
  if (!c) throw new Error(`control ${id} is not in ${AREAS_FILE}`);
  return c;
};
const res = (id: string): readonly Resource[] => ctl(id).resources ?? [];
const urls = (id: string): string[] => res(id).map((r) => r.url);
const hosts = (id: string): string[] => urls(id).map((u) => new URL(u).host);
const everyResource = () => controls().flatMap((c) => (c.resources ?? []).map((r) => ({ controlId: c.id, ...r })));
/** How many controls list this exact url. */
const usedBy = (url: string): number => controls().filter((c) => (c.resources ?? []).some((r) => r.url === url)).length;
const parse = (u: string): URL | null => {
  try {
    return new URL(u);
  } catch {
    return null;
  }
};

const TECHNICAL = ['C-03', 'C-04', 'C-05', 'C-10', 'C-13', 'C-14', 'C-15', 'C-16', 'C-18', 'C-21'];
const NO_TEMPLATE_NO_NOTEBOOK = ['C-06', 'C-08', 'C-09', 'C-12', 'C-20', 'C-22', 'C-23', 'C-24', 'C-27']; // SRS line 4250
/** The ten controls whose resource in 4.0.0 was the Playbook landing page (SRS line 4252). */
const PLAYBOOK_CONTROLS = ['C-01', 'C-02', 'C-07', 'C-08', 'C-09', 'C-22', 'C-23', 'C-24', 'C-26', 'C-28'];

const isPlaybookLanding = (u: URL): boolean => {
  if (u.host !== 'airc.nist.gov') return false;
  const p = u.pathname.replace(/\/+$/, '').toLowerCase();
  // The 4.0.0 address, and the page it redirects to on 30 Oct 2026: both are the one landing page.
  return p === '/ai_rmf_knowledge_base/playbook' || p === '/airmf-resources/playbook';
};
const isPlaybookFunctionPage = (u: URL): boolean =>
  u.host === 'airc.nist.gov' && !isPlaybookLanding(u) && /^(govern|map|measure|manage)$/i.test(u.pathname.replace(/\/+$/, '').split('/').pop() ?? '');

/**
 * Every host a control resource may point to (R2): the project's or publisher's own site. Adding a
 * host is a visible change to this list, and the review of the links reads each new entry.
 * A host that many projects share (github.com, pypi.org, doi.org, arxiv.org, huggingface.co) is
 * listed too, but a host check cannot tell one project's page on it from another's; the review
 * of the links does that.
 */
const OFFICIAL_HOSTS: Record<string, string> = {
  // Kept from 4.0.0 (FR-PUB-03 "shall keep").
  'airc.nist.gov': 'NIST AI Resource Center: AI RMF Playbook',
  'www.canada.ca': 'Government of Canada: Algorithmic Impact Assessment tool',
  'eur-lex.europa.eu': 'EU Publications Office: text of the EU AI Act',
  'www.who.int': 'World Health Organization: ethics and governance of AI for health',
  'nvlpubs.nist.gov': 'NIST: Special Publication 1270',
  'aif360.readthedocs.io': 'IBM AI Fairness 360 documentation (stays on C-06 only, CG-07)',
  'fairlearn.org': 'Fairlearn project',
  'oecd.ai': 'OECD AI Policy Observatory: AI Principles',
  'scikit-learn.org': 'scikit-learn project',
  'www.dama.org': 'DAMA International',
  'www.unesco.org': 'UNESCO: Recommendation on the Ethics of AI',
  'gdpr-info.eu': 'NOT the EU: a private reproduction of the GDPR text, kept from 4.0.0 on C-11 beside the official text on eur-lex.europa.eu',
  'doi.org': 'DOI resolver: Mitchell et al. (2019), Model Cards for Model Reporting',
  'github.com': 'GitHub: Google Model Card Toolkit (tensorflow/model-card-toolkit)',
  'huggingface.co': 'Hugging Face: model card and dataset card guides',
  'arxiv.org': 'arXiv: Gebru et al., Datasheets for Datasets',
  'labelstud.io': 'Label Studio (HumanSignal)',
  'au.int': 'African Union: Continental AI Strategy',
  'www.iso.org': 'ISO: ISO/IEC 42001',
  // Added in 5.0.0 for CG-03 to CG-09 (tools the SRS 10.5.1 table records).
  'pandas.pydata.org': 'pandas project',
  'docs.scipy.org': 'SciPy project',
  'www.statsmodels.org': 'statsmodels project',
  'pypi.org': 'Python Package Index: pycanon',
  'docs.python.org': 'Python Software Foundation: standard library documentation',
  'shap.readthedocs.io': 'SHAP project',
  'adversarial-robustness-toolbox.readthedocs.io': 'Adversarial Robustness Toolbox project (CG-03)',
  'docs.evidentlyai.com': 'Evidently project',
  'docs.codecarbon.io': 'CodeCarbon project (CG-04)',
  'doc.dvc.org': 'DVC project (CG-05)',
  'mlflow.org': 'MLflow project (CG-05)',
  'git-scm.com': 'Git project (CG-05)',
  // Added in 5.0.0 for CG-09 (a resource specific to a control that has neither template nor notebook).
  'docs.cloud.google.com': 'Google Cloud documentation: MLOps guide, retraining triggers (C-22)',
  'sre.google': 'Google Site Reliability Engineering: canarying releases (C-23)',
  'www.elementsofai.com': 'Elements of AI: free course by the University of Helsinki and MinnaLearn (C-27)',
  // Added for owner answer A3 (OD-21 (a)).
  'www.equator-network.org': 'EQUATOR Network (OD-21)',
};

const RESOURCE_TYPES = ['tool', 'framework', 'paper', 'guidance'];

describe('control resource links (CG-03 to CG-09, FR-PUB-03, OD-21)', () => {
  it('CG-06 FR-PUB-03: every technical control has at least one tool resource', () => {
    for (const id of TECHNICAL) expect(res(id).some((r) => r.type === 'tool'), id).toBe(true);
  });

  it('CG-07: Fairlearn on C-13, C-14 and C-15; AIF360 off C-12; kappa pages on C-12', () => {
    for (const id of ['C-13', 'C-14', 'C-15']) expect(hosts(id), id).toContain('fairlearn.org');
    expect(urls('C-12').some((u) => u.includes('aif360'))).toBe(false);
    expect(urls('C-12').some((u) => /cohen_kappa_score/.test(u))).toBe(true);
    expect(urls('C-12').some((u) => /fleiss_kappa/.test(u))).toBe(true);
  });

  it('CG-03: an Adversarial Robustness Toolbox resource on C-18', () => {
    const isArt = (u: URL) =>
      u.host === 'adversarial-robustness-toolbox.readthedocs.io' ||
      (u.host === 'github.com' && u.pathname.toLowerCase().startsWith('/trusted-ai/adversarial-robustness-toolbox'));
    expect(res('C-18').some((r) => isArt(new URL(r.url)))).toBe(true);
    // The project's repository, where its releases are: the readthedocs build is headed 1.17.0 and has no
    // stable version, while SRS CG-03 (line 4261) records 1.20.1.
    const art = res('C-18').filter((r) => isArt(new URL(r.url)));
    expect(art.map((r) => [r.url, r.title, r.type])).toEqual([
      ['https://github.com/Trusted-AI/adversarial-robustness-toolbox', 'Adversarial Robustness Toolbox (GitHub)', 'tool'],
    ]);
  });

  it('CG-04: a CodeCarbon resource on C-02', () => {
    const isCodeCarbon = (u: URL) =>
      u.host === 'docs.codecarbon.io' ||
      u.host === 'codecarbon.io' ||
      (u.host === 'github.com' && u.pathname.toLowerCase().startsWith('/mlco2/codecarbon'));
    expect(res('C-02').some((r) => isCodeCarbon(new URL(r.url)))).toBe(true);
  });

  it('CG-05: DVC, MLflow and Git resources on C-17', () => {
    const h = hosts('C-17');
    expect(h.some((x) => x === 'doc.dvc.org' || x === 'dvc.org'), 'DVC').toBe(true);
    expect(h, 'MLflow').toContain('mlflow.org');
    expect(h, 'Git').toContain('git-scm.com');
  });

  it('CG-08: no control links the Playbook landing page, and each former user links a function page', () => {
    for (const c of controls()) {
      for (const r of c.resources ?? []) expect(isPlaybookLanding(new URL(r.url)), `${c.id} ${r.url}`).toBe(false);
    }
    // Absence alone would be met by deleting the link, which is not "link to the function page that fits".
    for (const id of PLAYBOOK_CONTROLS) expect(res(id).some((r) => isPlaybookFunctionPage(new URL(r.url))), id).toBe(true);
  });

  it('CG-08: each former Playbook user links the function page that fits it, and its title cites a subcategory that page holds', () => {
    // The fit and the subcategory are the review of 30 Oct 2026 against each page's own statements. A title
    // names a topic only by the subcategory number the page uses: the pages have no named sections.
    const FIT: Record<string, [string, string | null]> = {
      'C-01': ['MAP', null], // MAP 1.1: "Identify whether there are non-AI or non-technology alternatives"
      'C-02': ['MAP', null], // MAP 3.1 and 3.2: benefits and costs
      'C-07': ['MAP', '5.1'], // each identified impact, "both potentially beneficial and harmful"
      'C-08': ['MAP', '2.3'], // "data collection and selection (e.g., availability, representativeness, suitability)"
      'C-09': ['GOVERN', null],
      'C-22': ['MANAGE', null], // MANAGE 2.2: sustain the value of deployed systems, drift
      'C-23': ['MANAGE', '1.1'], // "whether its development or deployment should proceed"
      'C-24': ['MANAGE', '2.4'], // "supersede, disengage, or deactivate AI systems"
      'C-26': ['GOVERN', '2.1'], // "Roles and responsibilities and lines of communication"
      'C-28': ['MANAGE', '4.1'], // "incident response, recovery, and change management"
    };
    expect(Object.keys(FIT).sort()).toEqual([...PLAYBOOK_CONTROLS].sort());
    const fnOf = (u: URL) => (u.pathname.replace(/\/+$/, '').split('/').pop() ?? '').toUpperCase();
    for (const [id, [fn, sub]] of Object.entries(FIT)) {
      const pages = res(id).filter((r) => isPlaybookFunctionPage(new URL(r.url)));
      expect(pages.map((r) => fnOf(new URL(r.url))), id).toEqual([fn]);
      const title = pages[0]?.title ?? '';
      if (sub === null) expect(title, id).toBe(`NIST AI RMF Playbook: ${fn} function`);
      else expect(title, id).toMatch(new RegExp(`^NIST AI RMF Playbook, ${fn} ${sub.replace('.', '\\.')}: \\S.*$`));
    }
  });

  it('CG-04 CG-05: the CodeCarbon, Git and MLflow links are the page a reader stays on, not a redirect page or a chooser', () => {
    // Each answered 200 on 30 Oct 2026, so the liveness check, which reads no body, cannot see this.
    const NOT_THE_PAGE: Record<string, string> = {
      'https://docs.codecarbon.io/': 'a meta refresh to latest/',
      'https://git-scm.com/doc': 'a meta refresh to http://git-scm.com/docs, a plain-http address',
      'https://mlflow.org/docs/latest/': 'a chooser between LLMs and agents and machine learning',
    };
    const bad = everyResource().filter((r) => Object.hasOwn(NOT_THE_PAGE, r.url)).map((r) => `${r.controlId} ${r.url}: ${NOT_THE_PAGE[r.url]}`);
    expect(bad).toEqual([]);
    expect(urls('C-02')).toContain('https://docs.codecarbon.io/latest/');
    expect(urls('C-17')).toContain('https://git-scm.com/docs');
    expect(urls('C-17')).toContain('https://mlflow.org/docs/latest/ml/'); // experiment tracking and model versioning
  });

  it('CG-09: each control with neither template nor notebook has a resource used by at most 3 controls', () => {
    for (const id of NO_TEMPLATE_NO_NOTEBOOK) expect(urls(id).some((u) => usedBy(u) <= 3), id).toBe(true);
  });

  it('FR-PUB-03: every 4.0.0 resource is kept except the CG-07 and CG-08 replacements', () => {
    expect(fixture).toHaveLength(40);
    const replaced = (row: { controlId: string; url: string }) => {
      const u = new URL(row.url);
      return isPlaybookLanding(u) || (row.controlId === 'C-12' && u.host === 'aif360.readthedocs.io');
    };
    const kept = fixture.filter((row) => !replaced(row));
    expect(kept.length).toBeGreaterThan(0);
    const missing = kept.filter((row) => !urls(row.controlId).includes(row.url)).map((row) => `${row.controlId} ${row.url}`);
    expect(missing).toEqual([]);
  });

  it('FR-PUB-03: C-11 keeps the gdpr-info.eu link and adds the official GDPR text from EUR-Lex', () => {
    const mirror = fixture.find((row) => row.controlId === 'C-11' && new URL(row.url).host === 'gdpr-info.eu');
    expect(mirror, 'the 4.0.0 fixture holds a gdpr-info.eu link on C-11').toBeDefined();
    expect(urls('C-11')).toContain(mirror!.url);
    const official = res('C-11').filter((r) => r.url === 'https://eur-lex.europa.eu/eli/reg/2016/679/oj');
    expect(official).toHaveLength(1);
    expect(official[0].title).toBe('Regulation (EU) 2016/679 (GDPR), official text');
  });

  it('CG-08 FR-PUB-03: every address the liveness check leaves to a person is a link of the 5.0.0 file', () => {
    // A stale entry would keep exempting an address the file no longer holds, and exempt it again if it came back.
    const linked = new Set(everyResource().map((r) => r.url));
    const stale = Object.keys(MANUAL_CHECK).filter((url) => !linked.has(url));
    expect(stale).toEqual([]);
  });

  it('CG-06 NFR-SEC-11: every resource url is https and parses', () => {
    const bad = everyResource().filter((r) => parse(r.url)?.protocol !== 'https:').map((r) => `${r.controlId} ${r.url}`);
    expect(bad).toEqual([]);
  });

  it('CG-06: every resource host is an official project host', () => {
    const bad = everyResource()
      .filter((r) => !Object.hasOwn(OFFICIAL_HOSTS, parse(r.url)?.host ?? ''))
      .map((r) => `${r.controlId} ${r.url}`);
    expect(bad).toEqual([]);
  });

  it('CG-06 NFR-PRIV-04: no resource url carries tracking or personal data', () => {
    const bad = everyResource()
      .filter((r) => {
        const u = parse(r.url);
        if (!u) return true;
        if (u.username !== '' || u.password !== '') return true;
        return [...u.searchParams].some(([k, v]) => k.toLowerCase().startsWith('utm_') || k.includes('@') || v.includes('@'));
      })
      .map((r) => `${r.controlId} ${r.url}`);
    expect(bad).toEqual([]);
  });

  it('CG-06 FR-PUB-01: resource titles make no claim and hold no dash', () => {
    // The FR-PUB-01 phrase pattern (SRS line 1103), then the 7.5.1 character rules: no em or en dash,
    // no curly quote, no emoji.
    const claim = /\bcomplian(ce|t)\b|\baudit(-ready| ready|ed)\b|aligned (to|with)\b|\bcertif(y|ied|ication)\b|\baccredit|\bscores?\b|cannot see your records/i;
    const characters = /[–—‘’“”]|\p{Extended_Pictographic}/u;
    const bad = everyResource()
      .filter((r) => typeof r.title !== 'string' || r.title.trim() === '' || claim.test(r.title) || characters.test(r.title))
      .map((r) => `${r.controlId} ${JSON.stringify(r.title)}`);
    expect(bad).toEqual([]);
  });

  it('CG-06 OD-21: type is one of tool, framework, paper, guidance', () => {
    const bad = everyResource()
      .filter((r) => !RESOURCE_TYPES.includes(r.type ?? ''))
      .map((r) => `${r.controlId} ${r.url} type=${String(r.type)}`);
    expect(bad).toEqual([]);
  });

  it('OD-21 FR-PUB-03: the EQUATOR library and the three AI guideline pages are linked as guidance on the controls they serve', () => {
    const EQ = 'www.equator-network.org';
    // The AI and machine-learning hub page (/reporting-guidelines-study-design/...) no longer exists upstream; the library is its replacement.
    const LIBRARY = '/reporting-guidelines/';
    const TRIPOD = '/reporting-guidelines/tripod-statement/';
    const CONSORT = '/reporting-guidelines/consort-artificial-intelligence/';
    const SPIRIT = '/reporting-guidelines/spirit-artificial-intelligence/';
    const on = (id: string, path: string) =>
      res(id).filter((r) => {
        const u = new URL(r.url);
        return u.protocol === 'https:' && u.host === EQ && u.pathname === path;
      });
    // The library on the model card and datasheet controls: its index tags guidelines for AI and machine-learning
    // studies, some for the data section. Not on C-28, which documents a deployment: reporting guidelines write
    // up research, and the library names no deployment or software guideline (review of 30 Oct 2026).
    for (const id of ['C-17', 'C-19']) {
      expect(on(id, LIBRARY), id).toHaveLength(1);
      expect(on(id, LIBRARY)[0].title, id).toBe('EQUATOR Network: reporting guidelines library');
    }
    expect(on('C-17', TRIPOD)).toHaveLength(1); // TRIPOD+AI on the model card control
    expect(on('C-23', CONSORT)).toHaveLength(1); // trial reporting and protocols
    expect(on('C-23', SPIRIT)).toHaveLength(1);
    // Every EQUATOR link, whichever control holds it: guidance, written with the trailing slash, no query.
    for (const r of everyResource().filter((x) => new URL(x.url).host === EQ)) {
      expect(r.type, `${r.controlId} ${r.url}`).toBe('guidance');
      expect(r.url.endsWith('/'), `${r.controlId} ${r.url}`).toBe(true);
      expect(new URL(r.url).search, `${r.controlId} ${r.url}`).toBe('');
    }
    const all = controls().flatMap((c) =>
      (c.resources ?? []).filter((r) => new URL(r.url).host === EQ).map((r) => `${c.id} ${new URL(r.url).pathname}`),
    );
    // These five links and no other EQUATOR link.
    expect(all.sort()).toEqual(['C-17 ' + LIBRARY, 'C-17 ' + TRIPOD, 'C-19 ' + LIBRARY, 'C-23 ' + CONSORT, 'C-23 ' + SPIRIT].sort());
  });
});
