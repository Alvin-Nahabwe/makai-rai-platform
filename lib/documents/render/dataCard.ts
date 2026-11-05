import { renderFieldDocument } from './frame';
import type { Renderer } from './index';

export const renderDataCard: Renderer = (input) => renderFieldDocument(input, 'Data card');
