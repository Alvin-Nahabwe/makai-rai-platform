import { renderFieldDocument } from './frame';
import type { Renderer } from './index';

export const renderMitigationPlan: Renderer = (input) => renderFieldDocument(input, 'Mitigation plan');
