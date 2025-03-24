import {
    ILogger,
    IModify,
    IPersistence,
    IRead,
} from '@rocket.chat/apps-engine/definition/accessors';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { Review, ReviewStatus } from '../data/Review';
import { ReviewManager } from '../services/ReviewManager';
import { NotificationService } from '../services/NotificationService';

/**
 * Handler for approve actions on FAQ reviews
 */
export class ApproveActionHandler {
    private readonly read: IRead;
    private readonly persistence: IPersistence;
    private readonly modify: IModify;
    private readonly logger?: ILogger;

    /**
     * Creates a new ApproveActionHandler instance
     * @param read - The read accessor
     * @param persistence - The persistence accessor
     * @param modify - The modify accessor
     * @param logger - The logger accessor
     */
    constructor(read: IRead, persistence: IPersistence, modify: IModify, logger?: ILogger) {
        this.read = read;
        this.persistence = persistence;
        this.modify = modify;
        this.logger = logger;
    }

    /**
     * Handles the approve action for a review
     * @param reviewId - The ID of the review to approve
     * @param user - The user who approved the review
     * @returns Promise that resolves when the action is handled
     */
    public async handleApproveAction(reviewId: string, user: IUser): Promise<void> {
        this.log('debug', `Starting approve action for review ${reviewId} by user ${user.username}`);
        
        try {
            // Initialize services
            this.log('debug', 'Initializing services');
            const reviewManager = new ReviewManager(this.persistence, this.read.getPersistenceReader());
            const notificationService = new NotificationService(this.read, this.modify);
            
            // Get the review by ID
            this.log('debug', `Retrieving review with ID: ${reviewId}`);
            const review = await reviewManager.getReviewById(reviewId);
            
            if (!review) {
                this.log('error', `Review not found with ID: ${reviewId}`);
                throw new Error(`Invalid review ID: ${reviewId}`);
            }
            
            // Update the review status to APPROVED
            this.log('debug', `Updating review ${reviewId} status to APPROVED`);
            await reviewManager.updateReviewStatus(reviewId, ReviewStatus.APPROVED);
            
            // Send the approved answer to the original room
            this.log('debug', `Sending approved answer to original room`);
            const room = await this.read.getRoomReader().getById(review.roomId);
            
            if (!room) {
                this.log('error', `Original room not found: ${review.roomId}`);
                throw new Error(`Original room not found: ${review.roomId}`);
            }
            
            // Send the response to the original room
            await this.sendResponse(
                `Here's an answer to your question: ${review.proposedAnswer}`,
                review.roomId
            );
            
            // Send confirmation to the reviewer
            this.log('debug', `Sending confirmation to reviewer ${user.username}`);
            await notificationService.sendActionConfirmation(
                review,
                user,
                'approve'
            );
            
            this.log('info', `Review ${reviewId} successfully approved by ${user.username}`);
        } catch (error) {
            this.log('error', `Error in handleApproveAction: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Sends a message to the specified room
     * @param text - The message text
     * @param roomId - The ID of the room to send the message to
     */
    private async sendResponse(text: string, roomId: string): Promise<void> {
        try {
            const room = await this.read.getRoomReader().getById(roomId);
            
            if (!room) {
                this.log('error', `Room not found: ${roomId}`);
                throw new Error(`Room not found: ${roomId}`);
            }
            
            // Add a prefix to the message to identify it as a response from the app
            const responseText = `🤖 FAQ Bot: ${text}`;
            
            const messageBuilder = this.modify.getCreator().startMessage()
                .setRoom(room)
                .setText(responseText);
            
            await this.modify.getCreator().finish(messageBuilder);
            this.log('debug', `Message sent to room ${roomId}`);
        } catch (error) {
            this.log('error', `Error sending message: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Helper method to log messages with a consistent prefix
     */
    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        const prefix = '[ApproveActionHandler]';
        
        if (!this.logger) {
            switch (level) {
                case 'debug':
                    console.debug(`${prefix} ${message}`);
                    break;
                case 'info':
                    console.info(`${prefix} ${message}`);
                    break;
                case 'warn':
                    console.warn(`${prefix} ${message}`);
                    break;
                case 'error':
                    console.error(`${prefix} ${message}`);
                    break;
            }
        } else {
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
        }
    }
} 