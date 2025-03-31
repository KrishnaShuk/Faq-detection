import { ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import { FAQ } from '../data/faqs';
import { BM25Service } from './BM25Service';

/**
 * Message types for classification
 */
export enum MessageType {
    /**
     * Alpha message - Direct match to FAQ, can be answered without LLM
     */
    ALPHA = 'alpha',
    
    /**
     * Beta message - Requires LLM processing and review
     */
    BETA = 'beta',
    
    /**
     * Unrelated message - Not a question or not related to FAQs
     */
    UNRELATED = 'unrelated'
}

/**
 * Result of message classification
 */
export interface ClassificationResult {
    /**
     * Type of message (alpha, beta, unrelated)
     */
    type: MessageType;
    
    /**
     * Matched FAQ for alpha messages
     */
    matchedFaq?: FAQ;
    
    /**
     * Similarity score (0-1)
     */
    score: number;
    
    /**
     * Original message text
     */
    message: string;
}

/**
 * Service for classifying messages as Alpha or Beta
 */
export class MessageClassifier {
    private bm25Service: BM25Service;
    
    /**
     * Creates a new MessageClassifier instance
     * @param faqs - The list of FAQs to use for classification
     * @param similarityThreshold - Threshold for direct matches (Alpha messages)
     * @param logger - Logger instance
     */
    constructor(
        private readonly faqs: FAQ[],
        private similarityThreshold: number,
        private readonly logger: ILogger
    ) {
        this.bm25Service = new BM25Service(faqs);
    }
    
    /**
     * Classifies a message as Alpha, Beta, or Unrelated
     * @param message - The message text to classify
     * @returns Classification result
     */
    public classifyMessage(message: string): ClassificationResult {
        this.logger.debug(`[MessageClassifier] Classifying message: ${message}`);
        
        // Skip very short messages or non-questions
        if (message.length < 5 || !this.looksLikeQuestion(message)) {
            this.logger.debug(`[MessageClassifier] Message too short or not a question`);
            return {
                type: MessageType.UNRELATED,
                score: 0,
                message
            };
        }
        
        // Search for matching FAQ using BM25
        const searchResult = this.bm25Service.search(message, this.faqs, this.similarityThreshold);
        this.logger.debug(`[MessageClassifier] BM25 search result: ${JSON.stringify(searchResult)}`);
        
        if (searchResult.isDirectMatch && searchResult.faq) {
            // Alpha message - direct match
            this.logger.debug(`[MessageClassifier] Alpha message detected with score: ${searchResult.score}`);
            return {
                type: MessageType.ALPHA,
                matchedFaq: searchResult.faq,
                score: searchResult.score,
                message
            };
        } else if (searchResult.score > 0) {
            // Beta message - potential match but needs LLM
            this.logger.debug(`[MessageClassifier] Beta message detected with score: ${searchResult.score}`);
            return {
                type: MessageType.BETA,
                score: searchResult.score,
                message
            };
        } else {
            // Unrelated message
            this.logger.debug(`[MessageClassifier] Unrelated message detected`);
            return {
                type: MessageType.UNRELATED,
                score: 0,
                message
            };
        }
    }
    
    /**
     * Updates the FAQs used for classification
     * @param newFaqs - The new list of FAQs
     */
    public updateFaqs(newFaqs: FAQ[]): void {
        // Create a new BM25Service with the updated FAQs
        this.bm25Service = new BM25Service(newFaqs);
    }
    
    /**
     * Updates the similarity threshold
     * @param threshold - The new threshold value
     */
    public updateThreshold(threshold: number): void {
        this.similarityThreshold = threshold;
    }
    
    /**
     * Heuristic to determine if a message looks like a question
     * @param message - The message to check
     * @returns True if the message looks like a question
     */
    private looksLikeQuestion(message: string): boolean {
        // Check for question marks
        if (message.includes('?')) {
            return true;
        }
        
        // Check for common question words at the start
        const lowerMessage = message.toLowerCase().trim();
        const questionStarters = ['how', 'what', 'when', 'where', 'why', 'who', 'which', 'can', 'could', 'would', 'is', 'are', 'do', 'does'];
        
        for (const starter of questionStarters) {
            if (lowerMessage.startsWith(starter + ' ')) {
                return true;
            }
        }
        
        return false;
    }
}
