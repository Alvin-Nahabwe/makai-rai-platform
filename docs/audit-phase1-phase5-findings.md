# UI/UX Audit — Phase 1 & Phase 5 Findings

**Platform:** MAK-AI Responsible AI Toolkit  
**Date:** 2026-07-03  
**Scope:** Design System Integrity (Phase 1) · Modern Web Standards (Phase 5)  
**Auditor:** Automated deep-scan  

---

## Severity Scale

| Level | Label | Definition |
|-------|-------|------------|
| **4** | Critical | Prevents task completion or data loss |
| **3** | Major | Significant difficulty or standards violation |
| **2** | Minor | Inconsistency or missing best practice |
| **1** | Cosmetic | Polish issue |

---

## Summary

| Phase | Critical | Major | Minor | Cosmetic | Total |
|-------|----------|-------|-------|----------|-------|
| Phase 1 — Design System Integrity | 0 | 6 | 9 | 4 | 19 |
| Phase 5 — Modern Web Standards | 0 | 5 | 7 | 2 | 14 |
| **Total** | **0** | **11** | **16** | **6** | **33** |

---

# Phase 1 — Design System Integrity

## 1.1 Token Coverage — Hardcoded Hex Colors

> **Severity: 3 Major**  
> Massive inline-style color usage bypasses the design token system, making theming / dark-mode impossible without touching every component.

### Component files (TSX) — 65+ hardcoded hex values

| File | Lines | Example values |
|------|-------|----------------|
| [ScoreGauge.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/dashboard/ScoreGauge.tsx#L10-L53) | 10, 11, 53 | `#C06014`, `#E5E7EB`, `#1A1F36` |
| [GapHeatmap.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/dashboard/GapHeatmap.tsx#L25-L221) | 25-28, 100, 107, 121, 124, 143, 145, 183, 193, 207, 221 | `#D1FAE5`, `#FEF3C7`, `#FEE2E2`, `#F9FAFB`, `#6B7280`, `#374151`, `#fff`, `#FAFAFA` |
| [TrendChart.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/dashboard/TrendChart.tsx#L25-L88) | 25, 54, 59, 65, 68, 71, 79, 81, 88 | `#C06014`, `#6B7280`, `#1A1F36`, `#F3F4F6`, `#9CA3AF`, `#059669` |
| [RadarChart.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/dashboard/RadarChart.tsx#L28-L127) | 28-36, 96, 99, 104, 119, 122, 127 | `#C06014`, `#2563EB`, `#059669`, `#7C3AED`, `#DB2777`, `#D97706`, `#0891B2`, `#4F46E5` |
| [ReportSummary.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/report/ReportSummary.tsx#L48-L60) | 48, 52, 56, 60 | `#22C55E`, `#F59E0B`, `#F97316`, `#C06014` |
| [AreaCard.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/report/AreaCard.tsx#L12-L46) | 12-13, 17, 24, 28, 45-46 | `#16A34A`, `#DCFCE7`, `#15803D`, `#86EFAC`, `#FBBF24`, `#78350F`, `#FEF3C7`, `#92400E`, `#F59E0B`, `#F3F4F6`, `#6B7280` |
| [ResetModal.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/assessment/ResetModal.tsx#L22) | 22 | `#DC2626` |
| [about/page.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/(authenticated)/explore/about/page.tsx#L34) | 34, 53, 72, 179, 206, 229, 252, 277, 301, 324, 346 | `#C06014`, `#8B4513`, `#A0522D` |
| [controls/page.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/(authenticated)/explore/controls/page.tsx#L18-L20) | 18-20 | `#C06014`, `#8B4513`, `#A0522D` |
| [assessment page.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/(authenticated)/assessment/%5Bid%5D/page.tsx#L339) | 339 | `#DC2626` |
| [report page.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/(authenticated)/assessment/%5Bid%5D/report/page.tsx#L153) | 153 | `#999` |

### Component CSS files — 35+ hardcoded hex values

| File | Lines | Example values |
|------|-------|----------------|
| [AssessmentPage.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/assessment/AssessmentPage.css#L42) | 42, 399, 537 | `#FFF5EB`, `#FEE2E2`, `#A0522D` |
| [ReportPage.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/report/ReportPage.css#L104-L309) | 104-106, 109, 122, 133-135, 138, 268-269, 273, 287, 308-309, 320 | `#F97316`, `#22C55E`, `#F59E0B`, `#FFEDD5`, `#FEE2E2`, `#DC2626`, `#FFF5EB`, `#C06014`, `#8B4513`, `#A0522D`, `#FEF3C7`, `#92400E`, `#5C2D0E`, `#ddd` |
| [ReferencesList.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/report/ReferencesList.css#L197-L216) | 197, 209-210, 215-216 | `#FFF5EB`, `#FFF0E0`, `#FFF0F0`, `#FFE8E8`, `#B03030`, `#F0F4FF`, `#E8EDFF`, `#4A5FBD` |
| [ControlResourcesList.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/report/ControlResourcesList.css#L20-L210) | 20, 22, 32, 41, 147-158, 198-210 | `#8B4513`, `#C06014`, `#E8EDFF`, `#D8DFFF`, `#4A5FBD`, `#E8FFE8`, `#D0F0D0`, `#2E7D32`, `#FFF0E0`, `#FFE4CC` |

### globals.css — hardcoded hex outside `:root` tokens

| File | Lines | Context |
|------|-------|---------|
| [globals.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L255-L256) | 255-256 | `.btn--green:hover` uses `#5C2D0E` instead of `var(--color-primary-dark)` |
| [globals.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L287) | 287 | `.card:hover` border uses `rgba(192, 96, 20, 0.12)` — should be token |
| [globals.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L308) | 308 | `.badge--critical` background `#FEE2E2` — no token defined |
| [globals.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L313) | 313 | `.badge--high` background `#FFEDD5` — no token defined |
| [globals.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L318) | 318 | `.badge--moderate` uses hardcoded `#A16207` instead of a token |
| [globals.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L323) | 323 | `.badge--low` uses hardcoded `#15803D` instead of a token |
| [globals.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L357) | 357 | `.stage-indicator--pre` background `#FFF5EB` — no token |
| [globals.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L809) | 809 | Print styles use `#ddd`, `#eee`, `#ccc` |
| [globals.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L920) | 920 | `.badge--system-type` background `#FFF5EB` |
| [globals.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L1092-L1207) | 1092-1207 | Admin badges, stat cards, completion bars all use hardcoded colors like `#EDE9FE`, `#7C3AED`, `#DBEAFE`, `#2563EB`, `#15803D`, `#A16207`, `#22C55E`, `#16A34A` |

---

## 1.2 Token Coverage — Hardcoded Font Sizes & Magic Numbers

> **Severity: 2 Minor**

### Hardcoded `fontSize` in inline styles (px values passed as numbers)

| File | Lines | Values |
|------|-------|--------|
| [GapHeatmap.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/dashboard/GapHeatmap.tsx#L91-L182) | 91, 106, 123, 182 | `13`, `12`, `12`, `12` |
| [TrendChart.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/dashboard/TrendChart.tsx#L54-L81) | 54, 59, 69, 81 | `11`, `11`, `12`, `10` |
| [RadarChart.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/dashboard/RadarChart.tsx#L99-L127) | 99, 104, 123, 127 | `11`, `10`, `12`, `12` |
| [projects/[id]/page.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/(authenticated)/projects/%5Bid%5D/page.tsx#L89) | 89, 212 | `18`, `18` |
| [compare/page.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/(authenticated)/projects/%5Bid%5D/compare/page.tsx#L88-L121) | 88, 93, 102, 107, 116, 121 | `18`, `13`, `18`, `13`, `18`, `13` |

### Magic number spacing (px) in inline styles

| File | Lines | Values |
|------|-------|--------|
| [StartAssessmentButton.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/assessment/StartAssessmentButton.tsx#L40) | 40 | `marginBottom: 8` |
| [GapHeatmap.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/dashboard/GapHeatmap.tsx#L162-L222) | 162, 180, 181, 190-194, 204-208, 218-222 | `borderRadius: 4`, `gap: 16`, `marginTop: 12`, `width: 12`, `height: 12`, `borderRadius: 2`, `marginRight: 4` |
| [TrendChart.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/dashboard/TrendChart.tsx#L45-L67) | 45, 67 | `height: 300`, `borderRadius: 8` |
| [RadarChart.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/dashboard/RadarChart.tsx#L93-L121) | 93, 121 | `height: 400`, `borderRadius: 8` |
| [projects/[id]/page.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/(authenticated)/projects/%5Bid%5D/page.tsx#L66-L284) | 66, 71, 87, 89, 212, 227, 242, 248, 257-258, 284, 311 | `marginTop: 4`, `gap: 12`, `padding: 24`, `marginBottom: 16`, `padding: 20`, `gap: 16`, `gap: 10`, `marginBottom: 4`, `gap: 20`, `marginRight: 4` |
| [compare/page.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/(authenticated)/projects/%5Bid%5D/compare/page.tsx) | 59, 85, 87, 88, 93, 101-121 | `marginTop: 4`, `gap: 32`, `padding: 24`, `marginBottom: 16` |

---

## 1.3 Component State Coverage

> **Severity: 2 Minor**

### Buttons

| State | Covered? | Notes |
|-------|----------|-------|
| `:hover` | ✅ Yes | `.btn--primary:hover`, `.btn--secondary:hover`, `.btn--green:hover`, `.btn--outline:hover`, `.btn--danger-outline:hover` |
| `:active` | ❌ No | No `:active` state defined for any `.btn` variant in [globals.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L206) |
| `:focus-visible` | ✅ Yes | Global `*:focus-visible` rule covers buttons |
| `:disabled` | ⚠️ Partial | Only `.btn-primary:disabled` (L1596) has a disabled style. `.btn--primary:disabled`, `.btn--secondary:disabled`, `.btn--green:disabled` are **not defined** |

### Links

| State | Covered? | Notes |
|-------|----------|-------|
| `:hover` | ⚠️ Partial | Base `a:hover` (L144) sets same color as default — **no visual change** |
| `:active` | ❌ No | No `:active` state |
| `:focus-visible` | ✅ Yes | Global rule covers |
| `:visited` | ❌ No | Not defined |

### Inputs

| State | Covered? | Notes |
|-------|----------|-------|
| `:focus` | ✅ Yes | `.form-group input:focus`, `.auth-card input:focus` |
| `:disabled` | ❌ No | No disabled state for form inputs |
| `:invalid` / `:user-invalid` | ❌ No | No validation pseudo-class styling |
| `::placeholder` | ❌ No | No placeholder styling defined |

### Toggle/expand buttons

| State | Covered? | Notes |
|-------|----------|-------|
| `:hover` | ✅ Yes | `.toggle-btn:hover` |
| `:active` | ⚠️ Partial | Only in [ReferencesList.css L56](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/report/ReferencesList.css#L56) |

---

## 1.4 Naming Convention Consistency

> **Severity: 1 Cosmetic**

The codebase uses **predominantly BEM** naming, with some inconsistencies:

| Convention | Examples | Assessment |
|------------|----------|------------|
| **BEM (block__element--modifier)** | `.btn--primary`, `.card--bordered`, `.project-card__name`, `.progress-bar__fill--critical`, `.sidebar-link.active` | ✅ Dominant pattern |
| **Flat (single-dash)** | `.sidebar-link`, `.sidebar-header`, `.sidebar-footer`, `.back-link`, `.toggle-btn`, `.skip-link` | ✅ Acceptable for simple elements |
| **Inconsistent alias** | `.btn-primary` at [globals.css L1568](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L1568) duplicates `.btn--primary` with non-BEM name | ⚠️ **Dual naming** — noted in comments as "alias" |
| **Mixed dot-vs-active** | `.sidebar-link.active` instead of `.sidebar-link--active` | ⚠️ Uses JS-toggled `.active` class rather than BEM modifier |

### Duplicate definitions

| Issue | Files |
|-------|-------|
| `.btn-primary` is a near-copy of `.btn--primary` + `.btn` combined | [globals.css L1568-1599](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L1568-L1599) |

---

## 1.5 Missing Tokens

> **Severity: 2 Minor**

### Color tokens present vs. missing

| Token Category | Present | Missing |
|----------------|---------|---------|
| Primary palette | ✅ `--color-primary`, `--color-primary-dark`, `--color-primary-light`, `--color-accent-warm` | — |
| Navy | ✅ `--color-navy`, `--color-navy-light` | — |
| Risk colors | ✅ `--color-risk-critical`, `--color-risk-high`, `--color-risk-moderate`, `--color-risk-low` | — |
| Semantic info | ✅ `--color-info` | ❌ `--color-warning` (amber), `--color-success` (green), `--color-error` (alias for critical) |
| Risk backgrounds | ❌ | `--color-risk-critical-bg`, `--color-risk-high-bg`, `--color-risk-moderate-bg`, `--color-risk-low-bg` |
| Stage backgrounds | ❌ | `--color-pre-processing-bg`, `--color-in-processing-bg`, `--color-post-processing-bg` |
| Chart colors | ❌ | No chart color palette tokens (8 colors hardcoded in RadarChart.tsx) |

### Spacing tokens

| Present | Missing |
|---------|---------|
| `--space-1` through `--space-6`, `--space-8`, `--space-10`, `--space-12`, `--space-16`, `--space-20`, `--space-24` | ❌ `--space-7`, `--space-9`, `--space-14` (minor gaps in scale, acceptable) |

> **Spacing is well-covered.** The 4px base scale with intentional gaps is a valid design choice.

### Typography tokens

| Present | Missing |
|---------|---------|
| `--font-size-xs` through `--font-size-6xl` | ✅ Complete |
| `--font-weight-light` through `--font-weight-extrabold` | ✅ Complete |
| `--line-height-tight`, `--line-height-normal`, `--line-height-relaxed` | ✅ Complete |
| — | ❌ `--letter-spacing-*` tokens (values like `0.05em`, `0.08em`, `0.1em` are hardcoded in ~15 rules) |

### Other missing tokens

| Category | Missing |
|----------|---------|
| Z-index | `--z-index-modal`, `--z-index-sidebar`, `--z-index-skip-link` (values `100`, `10000` hardcoded) |
| Opacity | `--opacity-disabled` (value `0.6` at L1597) |
| Animation | Keyframe names are fine; timing tokens exist |

---

## 1.6 CSS Organization

> **Severity: 1 Cosmetic**

### Structure

[globals.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css) (1625 lines) is **well-organized** with clear section headers:

```
── Design Tokens ──
── Reset & Base ──
── Utility Classes ──
── Buttons ──
── Cards ──
── Risk level badges ──
── Stage indicators ──
── Progress bar ──
── Score display ──
── Responsive ──
── Accessibility ──
── Authenticated Page Layout ──
── Form Styles ──
── Print / PDF Export Styles ──
── Animations ──
── Dashboard ──
── Admin Pages ──
── Sidebar Navigation ──
── Public Layout ──
```

### Issues

| Issue | Severity | Location |
|-------|----------|----------|
| File is 1625 lines — borderline monolithic. Component CSS files exist for `AssessmentPage`, `ReportPage`, `ReferencesList`, `ControlResourcesList` but not for dashboard or layout components | 1 Cosmetic | [globals.css](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css) |
| `.btn--outline` and `.btn--danger-outline` share 6 identical property declarations (copy-paste) | 1 Cosmetic | [globals.css L1238-1266](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L1238-L1266) |
| `.btn-primary` duplicates `.btn` + `.btn--primary` rules as a flat alias | 2 Minor | [globals.css L1567-1599](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L1567-L1599) |
| No overly-specific selectors detected — good specificity hygiene | ✅ | — |
| Logical grouping and comment headers are excellent | ✅ | — |

---

# Phase 5 — Modern Web Standards

## 5.1 Native HTML vs JS Reinventions — Modals

> **Severity: 3 Major**

Both modal components use a **custom div-based modal pattern** instead of the native `<dialog>` element:

| Component | Approach | Issues |
|-----------|----------|--------|
| [CompletionModal.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/assessment/CompletionModal.tsx#L35-L36) | `<div className="completion-modal-overlay">` + `role="dialog"` | No native `<dialog>` element, no `showModal()`, no `::backdrop`, no native ESC-to-close, no focus trapping |
| [ResetModal.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/assessment/ResetModal.tsx#L16-L17) | `<div className="modal-overlay">` + `role="dialog"` | Same issues — also uses inline `style={{ background: '#DC2626' }}` for danger button |

**Both modals have:**
- ✅ `role="dialog"` and `aria-modal="true"` (good)
- ✅ `aria-labelledby` pointing to title (good)
- ❌ No focus trap implementation
- ❌ No ESC key handler
- ❌ No scroll lock on body
- ❌ Conditional rendering (`if (!show) return null`) instead of `<dialog>` open/close

---

## 5.2 Deprecated Patterns

> **Severity: 1 Cosmetic**

| Pattern | Found? | Details |
|---------|--------|---------|
| CSS floats for layout | ❌ Not found | ✅ CSS Grid and Flexbox used throughout |
| `clearfix` | ❌ Not found | ✅ |
| `-webkit-line-clamp` | ⚠️ Found | [globals.css L547-549](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L547-L549) — still needed for cross-browser multi-line truncation, but `line-clamp` is now broadly supported |
| `-webkit-font-smoothing` / `-moz-osx-font-smoothing` | ⚠️ Found | [globals.css L119-120](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L119-L120) — common practice, non-standard but acceptable |
| Deprecated JS APIs | ❌ Not found | ✅ |

---

## 5.3 Modern CSS Features Usage

> **Severity: 2 Minor**

| Feature | Used? | Details |
|---------|-------|---------|
| CSS Grid | ✅ Yes | `grid-template-columns` for `.app-layout`, `.projects-grid`, `.form-row`, `.admin-stats-row` |
| Flexbox | ✅ Yes | Used extensively throughout |
| CSS Custom Properties | ✅ Yes | Comprehensive `:root` token system |
| `container queries` / `@container` | ❌ No | Not used — grid columns use `auto-fill`/`auto-fit` with `minmax()` instead |
| `:has()` | ❌ No | Not used |
| `:user-valid` / `:user-invalid` | ❌ No | Not used — no form validation pseudo-classes |
| `color-mix()` | ❌ No | RGBA used for opacity variants instead |
| `inset` shorthand | ✅ Yes | Used in `.section--textured::after` (L897) and ScoreGauge (L47) |
| `prefers-reduced-motion` | ✅ Yes | [globals.css L442-449](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L442-L449) — excellent implementation |
| `scroll-behavior: smooth` | ✅ Yes | [globals.css L118](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L118) |
| `accent-color` | ✅ Yes | [globals.css L1564](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/globals.css#L1564) for checkboxes |

---

## 5.4 Form Patterns

> **Severity: 3 Major**

### Login form ([login/page.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/(public)/login/page.tsx))

| Check | Status | Details |
|-------|--------|---------|
| `autocomplete="email"` | ❌ Missing | Email input has no autocomplete attribute |
| `autocomplete="current-password"` | ❌ Missing | Password input has no autocomplete attribute |
| Native validation | ⚠️ Partial | Uses `required` attribute but relies on JS form handler |

### Register form ([register/page.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/(public)/register/page.tsx))

| Check | Status | Details |
|-------|--------|---------|
| `autocomplete="name"` | ❌ Missing | Name input has no autocomplete |
| `autocomplete="email"` | ❌ Missing | Email input has no autocomplete |
| `autocomplete="new-password"` | ❌ Missing | Password fields have no autocomplete |
| `minLength` validation | ✅ Present | Password has `minLength={8}` |
| `:user-valid` / `:user-invalid` styling | ❌ Missing | No validation state CSS |

### Assessment questions ([QuestionBlock.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/assessment/QuestionBlock.tsx))

| Check | Status | Details |
|-------|--------|---------|
| Radio groups | ✅ Good | Uses `role="radiogroup"` and `aria-labelledby` |
| Checkbox groups | ✅ Good | Uses `role="group"` and `aria-label` |
| Custom radio indicators | ⚠️ | Hides native radios in favor of styled spans — acceptable pattern |

### Project creation form ([projects/new/page.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/(authenticated)/projects/new/page.tsx))

| Check | Status | Details |
|-------|--------|---------|
| `autocomplete` attributes | ❌ Missing | No autocomplete on any field |
| Native validation feedback | ❌ Missing | Relies entirely on JS |

---

## 5.5 Image Handling

> **Severity: 3 Major**

### All `<img>` tags in the codebase

| File | Line | Tag | Issues |
|------|------|-----|--------|
| [Sidebar.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/components/layout/Sidebar.tsx#L28) | 28 | `<img src="/logo-makai-white.png" alt="MAK-AI" className="sidebar-logo" />` | ❌ No `loading`, no `width`/`height`, no `fetchpriority` |
| [login/page.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/(public)/login/page.tsx#L30) | 30 | `<img src="/logo-makai.png" alt="MAK-AI" className="auth-logo" />` | ❌ No `loading`, no `width`/`height`, no `fetchpriority` |
| [register/page.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/(public)/register/page.tsx#L41) | 41 | `<img src="/logo-makai.png" alt="MAK-AI" className="auth-logo" />` | ❌ No `loading`, no `width`/`height`, no `fetchpriority` |

**Common issues across all images:**

| Check | Status |
|-------|--------|
| `loading="lazy"` | ❌ Not used on any image (logos should actually use `loading="eager"` / `fetchpriority="high"`) |
| `width` / `height` attributes | ❌ Not set — causes CLS (Cumulative Layout Shift) |
| `srcset` / `<picture>` | ❌ Not used |
| `fetchpriority` | ❌ Not used |
| Next.js `<Image>` component | ❌ Not used anywhere — raw `<img>` tags bypass Next.js automatic optimization |

---

## 5.6 Font Loading

> **Severity: 3 Major**

Current implementation in [layout.tsx](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/layout.tsx#L13-L17):

```tsx
<head>
  <link
    href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Source+Sans+3:wght@300;400;500;600;700&display=swap"
    rel="stylesheet"
  />
</head>
```

| Check | Status | Details |
|-------|--------|---------|
| `display=swap` | ✅ Present | In the Google Fonts URL |
| `<link rel="preconnect">` to `fonts.googleapis.com` | ❌ Missing | Should preconnect to both `fonts.googleapis.com` and `fonts.gstatic.com` |
| `<link rel="preconnect">` to `fonts.gstatic.com` | ❌ Missing | The actual font files are served from this domain |
| Next.js `next/font` | ❌ Not used | Should use `next/font/google` for automatic font optimization, self-hosting, and zero layout shift |
| Render-blocking | ⚠️ Yes | Stylesheet link in `<head>` blocks rendering until fonts CSS is downloaded |
| Manual `<head>` insertion | ⚠️ Yes | Next.js App Router discourages manual `<head>` in layout — should use metadata API or `next/font` |

---

## 5.7 Miscellaneous Modern Web Standards

> **Severity: 2 Minor**

| Check | Status | Details |
|-------|--------|---------|
| `<html lang="en">` | ✅ Present | [layout.tsx L12](file:///home/alvin/Downloads/DSWB_RAI/toolkit-platform/app/layout.tsx#L12) |
| Skip link | ✅ Present | `.skip-link` class defined, keyboard accessible |
| `prefers-reduced-motion` | ✅ Present | Comprehensive animation disabling |
| `print-color-adjust` | ✅ Present | Both standard and `-webkit-` prefix |
| Focus indicators | ✅ Present | `:focus-visible` with 3px outline |
| `<nav aria-label>` | ✅ Present | Sidebar navigation has `aria-label="Main navigation"` |
| Dark mode support | ❌ Missing | No `prefers-color-scheme: dark` media query or dark mode tokens |
| CSP / security headers | Not in scope | Middleware-level concern |

---

# Prioritized Recommendations

## High Priority (address first)

| # | Finding | Phase | Severity | Recommendation |
|---|---------|-------|----------|----------------|
| 1 | 100+ hardcoded hex colors across components | P1 | 3 Major | Create semantic color tokens for backgrounds (`--color-risk-*-bg`, `--color-stage-*-bg`), chart palettes, and tier-specific colors. Replace all inline styles with CSS classes or CSS custom properties |
| 2 | Custom div modals instead of `<dialog>` | P5 | 3 Major | Refactor `CompletionModal` and `ResetModal` to use native `<dialog>` with `showModal()`, `::backdrop`, and auto focus-trapping |
| 3 | No `autocomplete` on auth forms | P5 | 3 Major | Add `autocomplete="email"`, `autocomplete="current-password"`, `autocomplete="new-password"`, `autocomplete="name"` |
| 4 | Raw `<img>` tags — no Next.js Image | P5 | 3 Major | Replace all `<img>` with `next/image` `<Image>` component; add `width`/`height`/`priority` |
| 5 | Google Fonts loaded without preconnect or `next/font` | P5 | 3 Major | Migrate to `next/font/google` for automatic optimization, or add `<link rel="preconnect">` hints |

## Medium Priority

| # | Finding | Phase | Severity | Recommendation |
|---|---------|-------|----------|----------------|
| 6 | Missing `:active` and `:disabled` states on buttons | P1 | 2 Minor | Add `.btn:active`, `.btn--primary:disabled`, `.btn--secondary:disabled` styles |
| 7 | `a:hover` has no visual change | P1 | 2 Minor | Make `a:hover` visually distinct (underline, darker shade, etc.) |
| 8 | Missing semantic color tokens (warning, success, error) | P1 | 2 Minor | Add `--color-warning`, `--color-success`, `--color-error` and background variants |
| 9 | No `letter-spacing` tokens | P1 | 2 Minor | Create `--letter-spacing-tight`, `--letter-spacing-normal`, `--letter-spacing-wide` |
| 10 | 60+ magic number px values in inline styles | P1 | 2 Minor | Create CSS classes or use token vars for repeated patterns (chart heights, legend dots, etc.) |
| 11 | No `:user-valid`/`:user-invalid` form styling | P5 | 2 Minor | Add validation state CSS using modern pseudo-classes |
| 12 | Duplicate `.btn-primary` alias | P1 | 2 Minor | Migrate auth pages to use `.btn .btn--primary` and remove the duplicate |
| 13 | `-webkit-line-clamp` without standard `line-clamp` | P5 | 2 Minor | Add `line-clamp: 2` alongside the `-webkit-` version |

## Low Priority

| # | Finding | Phase | Severity | Recommendation |
|---|---------|-------|----------|----------------|
| 14 | `.btn--outline` / `.btn--danger-outline` duplication | P1 | 1 Cosmetic | Extract shared base into a common class |
| 15 | globals.css at 1625 lines | P1 | 1 Cosmetic | Consider splitting dashboard and sidebar styles into their own CSS files |
| 16 | `.sidebar-link.active` uses non-BEM toggle | P1 | 1 Cosmetic | Consider renaming to `.sidebar-link--active` for consistency |
| 17 | No dark mode support | P5 | 1 Cosmetic | Out of current scope but recommended for future iteration |
| 18 | No container queries | P5 | 1 Cosmetic | Current `minmax()` grid pattern is adequate; consider container queries for card-level responsiveness |

---

*End of audit report.*
