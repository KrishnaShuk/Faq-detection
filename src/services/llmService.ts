import { IHttp } from '@rocket.chat/apps-engine/definition/accessors';
import { FAQ } from '../data/faqs';
import { FAQ_SYSTEM_PROMPT, createFaqUserPrompt } from '../prompts/prompts';

interface LLMResponse {
    matched: boolean;
    answer?: string;
    detectedQuestion?: string;
    error?: string;
}

export class LLMService {
    constructor(
        private readonly http: IHttp,
        private readonly apiKey: string,
        private readonly apiEndpoint: string,
        private readonly modelType: string = "meta-llama/Llama-3.2-11B-Vision-Instruct"
    ) {}

    async checkMessage(message: string, faqs: FAQ[]): Promise<LLMResponse> {
        try {
            console.log('Creating prompt for message:', message);
            const faqText = faqs.map(faq => 
                `Q: ${faq.question}\nA: ${faq.answer}`
            ).join('\n\n');
            const prompt = createFaqUserPrompt(message, faqText);
            console.log('Created prompt:', prompt);
            
            console.log('Making API call to:', this.apiEndpoint);
            console.log('Using model:', this.modelType);
            
            const requestData = {
                model: this.modelType,
                messages: [
                    {
                        role: "system",
                        content: FAQ_SYSTEM_PROMPT
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.7,
                max_tokens: 500
            };
            
            console.log('Request data:', JSON.stringify(requestData));
            
            const response = await this.http.post(this.apiEndpoint, {
                data: requestData,
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            
            console.log('API response status:', response.statusCode);
            
            if (response.statusCode !== 200) {
                console.error('API error response:', response.data);
                throw new Error(`API returned status code ${response.statusCode}`);
            }
            
            console.log('API response received');

            if (!response.data || !response.data.choices || !response.data.choices[0]) {
                console.error('Invalid API response structure:', JSON.stringify(response.data));
                throw new Error('Invalid API response');
            }

            const llmResponse = response.data.choices[0].message.content;
            console.log('LLM response:', llmResponse);
            
            // Check if the response indicates a match
            if (llmResponse.toLowerCase().includes('no match found')) {
                console.log('No match found in response');
                return { matched: false };
            }

            console.log('Match found, returning answer');
            
            // Clean up the response to ensure it's a single, well-formatted message
            const cleanedResponse = this.cleanResponse(llmResponse);
            
            // Find which FAQ was matched
            const matchedFaq = this.findMatchedFaq(llmResponse, faqs);
            
            return {
                matched: true,
                answer: cleanedResponse,
                detectedQuestion: matchedFaq ? matchedFaq.question : undefined
            };

        } catch (error) {
            console.error('LLM Service Error:', error);
            return {
                matched: false,
                error: 'Failed to process message'
            };
        }
    }

    // Clean and format the LLM response
    private cleanResponse(response: string): string {
        // Remove any "Q:" or "A:" prefixes that might be in the response
        let cleaned = response.replace(/^(Q|A):\s*/gm, '');
        
        // Remove any "No match found" text if it appears in part of the response
        cleaned = cleaned.replace(/no match found\.?/gi, '').trim();
        
        // If the response starts with the answer text from an FAQ, clean it up
        const faqAnswerPattern = /^To\s+.*?:\s*\n/i;
        cleaned = cleaned.replace(faqAnswerPattern, '');
        
        // Ensure the response doesn't have excessive newlines
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        
        return cleaned;
    }

    // Try to determine which FAQ was matched based on the response
    private findMatchedFaq(response: string, faqs: FAQ[]): FAQ | undefined {
        for (const faq of faqs) {
            // Check if the response contains significant portions of the answer
            const answerWords = faq.answer.split(/\s+/).filter(word => word.length > 4);
            const matchCount = answerWords.filter(word => 
                response.toLowerCase().includes(word.toLowerCase())
            ).length;
            
            // If more than 70% of significant words match, consider it a match
            if (answerWords.length > 0 && matchCount / answerWords.length > 0.7) {
                return faq;
            }
        }
        
        return undefined;
    }
} 