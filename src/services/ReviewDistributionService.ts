import { IPersistence, IPersistenceRead, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';
import { ILogger } from '@rocket.chat/apps-engine/definition/accessors';

/**
 * Service for distributing review tasks among reviewers in a round-robin fashion
 */
export class ReviewDistributionService {
    // Key for storing the last reviewer index in persistence
    private static readonly REVIEWER_INDEX_KEY = 'last_reviewer_index';
    
    /**
     * Creates a new ReviewDistributionService instance
     * @param read - The read accessor
     * @param persistence - The persistence accessor
     * @param persistenceRead - The persistence reader
     * @param logger - Logger instance
     */
    constructor(
        private readonly read: IRead,
        private readonly persistence: IPersistence,
        private readonly persistenceRead: IPersistenceRead,
        private readonly logger: ILogger
    ) {}
    
    /**
     * Selects the next reviewer in round-robin fashion
     * @param reviewerUsernames - List of all reviewer usernames
     * @returns The selected reviewer or undefined if none available
     */
    public async selectNextReviewer(reviewerUsernames: string[]): Promise<IUser | undefined> {
        this.logger.debug(`[ReviewDistributionService] Selecting next reviewer from ${reviewerUsernames.length} reviewers`);
        
        if (!reviewerUsernames || reviewerUsernames.length === 0) {
            this.logger.debug(`[ReviewDistributionService] No reviewers available`);
            return undefined;
        }
        
        // If only one reviewer, return them directly
        if (reviewerUsernames.length === 1) {
            const reviewer = await this.read.getUserReader().getByUsername(reviewerUsernames[0]);
            if (!reviewer) {
                this.logger.error(`[ReviewDistributionService] Reviewer not found: ${reviewerUsernames[0]}`);
                return undefined;
            }
            return reviewer;
        }
        
        // Get all available reviewers first to ensure we have valid users
        const availableReviewers = await this.getAllReviewers(reviewerUsernames);
        
        if (availableReviewers.length === 0) {
            this.logger.error(`[ReviewDistributionService] No valid reviewers found from usernames: ${reviewerUsernames.join(', ')}`);
            return undefined;
        }
        
        // Get the last used index
        let lastIndex = await this.getLastReviewerIndex();
        this.logger.debug(`[ReviewDistributionService] Last reviewer index: ${lastIndex}`);
        
        // If lastIndex is invalid or out of bounds, reset to -1
        if (lastIndex < -1 || lastIndex >= availableReviewers.length) {
            lastIndex = -1;
            this.logger.debug(`[ReviewDistributionService] Reset invalid index to -1`);
        }
        
        // Calculate the next index (round-robin)
        const nextIndex = (lastIndex + 1) % availableReviewers.length;
        this.logger.debug(`[ReviewDistributionService] Next reviewer index: ${nextIndex}`);
        
        // Get the next reviewer
        const reviewer = availableReviewers[nextIndex];
        this.logger.debug(`[ReviewDistributionService] Selected reviewer: ${reviewer.username}`);
        
        // Save the new index
        await this.saveReviewerIndex(nextIndex);
        
        return reviewer;
    }
    
    /**
     * Gets the last reviewer index from persistence
     * @returns The last index or -1 if not found
     */
    private async getLastReviewerIndex(): Promise<number> {
        try {
            const association = new RocketChatAssociationRecord(
                RocketChatAssociationModel.MISC,
                ReviewDistributionService.REVIEWER_INDEX_KEY
            );
            
            const records = await this.persistenceRead.readByAssociation(association);
            
            if (!records || records.length === 0) {
                return -1; // Start from the beginning
            }
            
            // Access the index property safely with type checking
            const record = records[0] as { index?: number };
            return typeof record.index === 'number' ? record.index : -1;
        } catch (error) {
            this.logger.error(`[ReviewDistributionService] Error getting last reviewer index: ${error}`);
            return -1; // Default to start from the beginning on error
        }
    }
    
    /**
     * Saves the current reviewer index to persistence
     * @param index - The index to save
     */
    private async saveReviewerIndex(index: number): Promise<void> {
        try {
            const association = new RocketChatAssociationRecord(
                RocketChatAssociationModel.MISC,
                ReviewDistributionService.REVIEWER_INDEX_KEY
            );
            
            // Remove old record if exists
            await this.persistence.removeByAssociations([association]);
            
            // Save new record
            await this.persistence.createWithAssociation({ index }, association);
            this.logger.debug(`[ReviewDistributionService] Saved reviewer index: ${index}`);
        } catch (error) {
            this.logger.error(`[ReviewDistributionService] Error saving reviewer index: ${error}`);
            // Continue execution even if saving fails
        }
    }
    
    /**
     * Gets all available reviewers
     * @param reviewerUsernames - List of reviewer usernames
     * @returns Array of reviewer user objects
     */
    public async getAllReviewers(reviewerUsernames: string[]): Promise<IUser[]> {
        const reviewers: IUser[] = [];
        
        for (const username of reviewerUsernames) {
            const user = await this.read.getUserReader().getByUsername(username);
            if (user) {
                reviewers.push(user);
            } else {
                this.logger.error(`[ReviewDistributionService] Reviewer not found: ${username}`);
            }
        }
        
        return reviewers;
    }
}
