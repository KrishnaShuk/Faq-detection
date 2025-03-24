/**
 * This file contains all the prompts used for LLM interactions
 */

/**
 * System prompt for the FAQ assistant
 */
export const FAQ_SYSTEM_PROMPT = 'You are a helpful FAQ assistant. Your task is to check if the user\'s message matches any FAQ questions and provide the corresponding answer if there\'s a match.';

/**
 * Creates the user prompt for FAQ matching
 * @param message - The user's message to check
 * @param faqText - The formatted FAQ text containing questions and answers
 * @returns The formatted user prompt
 */
export function createFaqUserPrompt(message: string, faqText: string): string {
    return `User Message: "${message}"

Available FAQs:
${faqText}

Please check if the user's message matches any of the FAQ questions. If there's a match, provide the corresponding answer with explanation.`;
} 