import { ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import { FAQ } from '../data/faqs';
import { BM25Service } from './BM25Service';

/**
 * Message types for classification
 */
export enum MessageType {
    /**
     * Alpha message - Direct match to FAQ, can be answered without LLM
     * Only messages with 99% confidence match are classified as Alpha
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
    
    // Default threshold set to 0.99 (99%) for Alpha messages
    private static readonly DEFAULT_SIMILARITY_THRESHOLD = 0.99;
    
    /**
     * Creates a new MessageClassifier instance
     * @param faqs - The list of FAQs to use for classification
     * @param similarityThreshold - Threshold for direct matches (Alpha messages), defaults to 0.99 (99%)
     * @param logger - Logger instance
     */
    constructor(
        private readonly faqs: FAQ[],
        private similarityThreshold: number = MessageClassifier.DEFAULT_SIMILARITY_THRESHOLD,
        private readonly logger: ILogger
    ) {
        this.bm25Service = new BM25Service(faqs);
        
        // Ensure threshold is at least 0.99 for strict Alpha classification
        if (this.similarityThreshold < 0.99) {
            this.logger.debug(`[MessageClassifier] Adjusting similarity threshold from ${this.similarityThreshold} to 0.99`);
            this.similarityThreshold = 0.99;
        }
    }
    
    /**
     * Classifies a message as Alpha, Beta, or Unrelated
     * @param message - The message text to classify
     * @returns Classification result
     */
    public classifyMessage(message: string): ClassificationResult {
        this.logger.debug(`[MessageClassifier] Classifying message: ${message}`);
        
        // Skip very short messages
        if (message.length < 5) {
            this.logger.debug(`[MessageClassifier] Message too short`);
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
            // Alpha message - direct match with 99% confidence
            this.logger.debug(`[MessageClassifier] Alpha message detected with score: ${searchResult.score}`);
            return {
                type: MessageType.ALPHA,
                matchedFaq: searchResult.faq,
                score: searchResult.score,
                message
            };
        } else {
            // Beta message - send to LLM for processing
            // All messages that don't have an exact match are sent to LLM
            this.logger.debug(`[MessageClassifier] Beta message detected with score: ${searchResult.score}`);
            return {
                type: MessageType.BETA,
                score: searchResult.score > 0 ? searchResult.score : 0.1, // Ensure a minimum score for tracking
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
        // Ensure threshold is at least 0.99 for strict Alpha classification
        if (threshold < 0.99) {
            this.logger.debug(`[MessageClassifier] Attempted to set threshold to ${threshold}, enforcing minimum of 0.99`);
            threshold = 0.99;
        }
        this.similarityThreshold = threshold;
    }
}
