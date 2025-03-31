import { FAQ } from '../data/faqs';

/**
 * Implementation of BM25 algorithm for FAQ matching
 * BM25 is a ranking function used in information retrieval
 */
export class BM25Service {
    private documents: string[] = [];
    private terms: Map<string, number[]> = new Map();
    private avgDocLength: number = 0;
    private docLengths: number[] = [];
    private idfCache: Map<string, number> = new Map();
    
    // BM25 parameters
    private k1: number = 1.2;  // Term frequency saturation parameter
    private b: number = 0.75;  // Document length normalization parameter
    
    /**
     * Creates a new BM25Service instance
     * @param faqs - The list of FAQs to index
     */
    constructor(faqs: FAQ[]) {
        this.indexFaqs(faqs);
    }
    
    /**
     * Indexes the FAQs for BM25 search
     * @param faqs - The FAQs to index
     */
    public indexFaqs(faqs: FAQ[]): void {
        this.documents = [];
        this.terms = new Map();
        this.docLengths = [];
        this.idfCache = new Map();
        
        // Process each FAQ question
        for (const faq of faqs) {
            this.documents.push(faq.question);
            const tokens = this.tokenize(faq.question);
            this.docLengths.push(tokens.length);
            
            // Count term frequencies in this document
            const termFreqs = new Map<string, number>();
            for (const token of tokens) {
                termFreqs.set(token, (termFreqs.get(token) || 0) + 1);
            }
            
            // Update the term index
            const docIndex = this.documents.length - 1;
            // Convert Map entries to array to avoid MapIterator issues
            Array.from(termFreqs.entries()).forEach(([term, freq]) => {
                if (!this.terms.has(term)) {
                    this.terms.set(term, new Array(this.documents.length).fill(0));
                }
                
                const termDocs = this.terms.get(term)!;
                // Ensure the array is long enough
                while (termDocs.length < this.documents.length) {
                    termDocs.push(0);
                }
                
                termDocs[docIndex] = freq;
            });
        }
        
        // Calculate average document length
        this.avgDocLength = this.docLengths.reduce((sum, len) => sum + len, 0) / this.docLengths.length || 0;
    }
    
    /**
     * Searches for the best matching FAQ for a query
     * @param query - The query text to match against FAQs
     * @param faqs - The list of FAQs to search
     * @param similarityThreshold - Minimum similarity score to consider a direct match
     * @returns The best matching FAQ and its similarity score
     */
    public search(query: string, faqs: FAQ[], similarityThreshold: number): { faq: FAQ | null, score: number, isDirectMatch: boolean } {
        const tokens = this.tokenize(query);
        const scores = this.calculateScores(tokens);
        
        // Find the highest scoring document
        let maxScore = -1;
        let maxIndex = -1;
        
        for (let i = 0; i < scores.length; i++) {
            if (scores[i] > maxScore) {
                maxScore = scores[i];
                maxIndex = i;
            }
        }
        
        // Determine if this is a direct match based on threshold
        const isDirectMatch = maxScore >= similarityThreshold;
        
        // Return the best matching FAQ, or null if none found
        return {
            faq: maxIndex >= 0 ? faqs[maxIndex] : null,
            score: maxScore,
            isDirectMatch
        };
    }
    
    /**
     * Calculates BM25 scores for all documents given query tokens
     * @param queryTokens - The tokenized query
     * @returns Array of scores for each document
     */
    private calculateScores(queryTokens: string[]): number[] {
        const scores = new Array(this.documents.length).fill(0);
        
        // Calculate score contribution for each query term
        for (const token of queryTokens) {
            // Skip terms not in the index
            if (!this.terms.has(token)) continue;
            
            const idf = this.getIdf(token);
            const termFreqs = this.terms.get(token)!;
            
            // Update scores for each document
            for (let i = 0; i < this.documents.length; i++) {
                const tf = termFreqs[i];
                if (tf === 0) continue;
                
                // BM25 formula
                const docLength = this.docLengths[i];
                const numerator = tf * (this.k1 + 1);
                const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / this.avgDocLength));
                
                scores[i] += idf * (numerator / denominator);
            }
        }
        
        return scores;
    }
    
    /**
     * Calculates the Inverse Document Frequency for a term
     * @param term - The term to calculate IDF for
     * @returns The IDF value
     */
    private getIdf(term: string): number {
        // Use cached value if available
        if (this.idfCache.has(term)) {
            return this.idfCache.get(term)!;
        }
        
        // Count documents containing this term
        const termDocs = this.terms.get(term);
        if (!termDocs) return 0;
        
        const docsWithTerm = termDocs.filter(freq => freq > 0).length;
        
        // Calculate IDF using the BM25 formula
        // Add 1 to document count to avoid division by zero
        const idf = Math.log(1 + (this.documents.length - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
        
        // Cache the result
        this.idfCache.set(term, idf);
        
        return idf;
    }
    
    /**
     * Tokenizes text into terms for indexing/searching
     * @param text - The text to tokenize
     * @returns Array of tokens
     */
    private tokenize(text: string): string[] {
        // Convert to lowercase
        const lowerText = text.toLowerCase();
        
        // Remove punctuation and split into words
        const words = lowerText.replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 0);
        
        // Remove common stopwords
        const stopwords = new Set([
            'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
            'in', 'on', 'at', 'to', 'for', 'with', 'by', 'about', 'of', 'do',
            'does', 'did', 'has', 'have', 'had', 'can', 'could', 'will', 'would',
            'should', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that'
        ]);
        
        return words.filter(word => !stopwords.has(word));
    }
    
    /**
     * Updates the BM25 parameters
     * @param k1 - Term frequency saturation parameter
     * @param b - Document length normalization parameter
     */
    public setParameters(k1: number, b: number): void {
        this.k1 = k1;
        this.b = b;
    }
}
