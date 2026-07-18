/** Type declarations for the plain-JS Quick Assessment engine. */
import type { Question } from '@/types/domain';

export const QUICK_QUESTIONS: string[];
export function isQuickQuestion(questionId: string): boolean;
export function getQuickQuestions(): Question[];
export function getQuickScore(responses: Record<string, number>): number;
