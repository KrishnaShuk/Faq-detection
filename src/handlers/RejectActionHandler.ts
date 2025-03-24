import { ILogger, IModify, IPersistence, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { ReviewStatus } from '../data/Review';
import { ReviewManager } from '../services/ReviewManager';
import { NotificationService } from '../services/NotificationService';

/**
 * Handler for reject actions on FAQ reviews
 */
export class RejectActionHandler {
    /**
     * Creates a new RejectActionHandler instance
     * @param read - The read accessor
     * @param persistence - The persistence accessor
     * @param modify - The modify accessor
     * @param logger - The logger
     */
    constructor(
        private readonly read: IRead,
        private readonly persistence: IPersistence,
        private readonly modify: IModify,
        private readonly logger?: ILogger
    ) {}

    /**
     * Handles the reject action for a review
     * @param reviewId - The ID of the review to reject
     * @param user - The user who rejected the review
     * @returns Promise that resolves when the action is handled
     */
    public async handleRejectAction(reviewId: string, user: IUser): Promise<void> {
        this.log('debug', `Starting reject action for review: ${reviewId}`);
        
        try {
            // Initialize services
            this.log('debug', `Initializing services`);
            const reviewManager = new ReviewManager(this.persistence, this.read.getPersistenceReader());
            const notificationService = new NotificationService(this.read, this.modify);
            
            // Get the review
            this.log('debug', `Retrieving review: ${reviewId}`);
            const review = await reviewManager.getReviewById(reviewId);
            
            if (!review) {
                this.log('error', `Review not found: ${reviewId}`);
                throw new Error(`Review not found: ${reviewId}`);
            }
            
            this.log('debug', `Found review: ${JSON.stringify({
                reviewId: review.reviewId,
                roomId: review.roomId,
                sender: review.senderUsername,
                status: review.status
            })}`);
            
            // Update review status
            this.log('debug', `Updating review status to REJECTED`);
            await reviewManager.updateReviewStatus(reviewId, ReviewStatus.REJECTED);
            
            // Send confirmation to the reviewer
            this.log('debug', `Sending confirmation to reviewer: ${user.username}`);
            await notificationService.sendActionConfirmation(review, user, 'reject');
            
            this.log('debug', `Reject action completed successfully for review: ${reviewId}`);
        } catch (error) {
            this.log('error', `Error handling reject action: ${error.message}`);
            throw error;
        }
    }

    /**
     * Logs a message with the appropriate log level
     * @param level - The log level
     * @param message - The message to log
     */
    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        const prefix = '[RejectActionHandler]';
        
        if (this.logger) {
            switch (level) {
                case 'debug':
                    this.logger.debug(`${prefix} ${message}`);
                    break;
                case 'info':
                    this.logger.info(`${prefix} ${message}`);
                    break;
                case 'warn':
                    this.logger.warn(`${prefix} ${message}`);
                    break;
                case 'error':
                    this.logger.error(`${prefix} ${message}`);
                    break;
            }
        } else {
            // Fallback to console if no logger is provided
            console.log(`${prefix} [${level.toUpperCase()}] ${message}`);
        }
    }
} 