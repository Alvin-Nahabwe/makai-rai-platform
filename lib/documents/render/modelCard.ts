import { renderFieldDocument } from './frame';
import type { Renderer } from './index';

export const renderModelCard: Renderer = (input) => renderFieldDocument(input, 'Model card');
