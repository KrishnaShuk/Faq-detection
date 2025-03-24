import { ILogger, IModify, IPersistence, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { Review, ReviewStatus } from '../data/Review';
import { ReviewManager } from '../services/ReviewManager';
import { NotificationService } from '../services/NotificationService';
import { ButtonStyle } from '@rocket.chat/apps-engine/definition/uikit';
import { TextObjectType } from '@rocket.chat/apps-engine/definition/uikit/blocks/Objects';
import { RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';

/**
 * Action IDs for the edit workflow
 */
enum EditActionIds {
    SUBMIT_EDIT = 'submit_edit',
    CANCEL_EDIT = 'cancel_edit'
}

/**
 * Handler for edit actions on FAQ reviews
 */
export class EditActionHandler {
    constructor(
        private readonly read: IRead,
        private readonly persistence: IPersistence,
        private readonly modify: IModify,
        private readonly logger?: ILogger
    ) {}

    /**
     * Handles the edit action for a review
     * @param reviewId - The ID of the review to edit
     * @param user - The user who initiated the edit
     * @returns Promise that resolves when the action is handled
     */
    public async handleEditAction(reviewId: string, user: IUser): Promise<void> {
        this.log('debug', `Starting edit action for review: ${reviewId}`);
        
        try {
            // Initialize services
            const reviewManager = new ReviewManager(this.persistence, this.read.getPersistenceReader());
            const notificationService = new NotificationService(this.read, this.modify);
            
            // Get the review
            const review = await reviewManager.getReviewById(reviewId);
            
            if (!review) {
                this.log('error', `Review not found: ${reviewId}`);
                throw new Error(`Review not found: ${reviewId}`);
            }

            // Get DM room with the reviewer
            const room = await notificationService.getDMRoom(user);
            
            if (!room) {
                this.log('error', `Could not get DM room for user: ${user.username}`);
                throw new Error(`Could not get DM room for user ${user.username}`);
            }
            
            // Since modals are complex to implement in Rocket.Chat App Engine,
            // we'll use an interactive message approach similar to the screenshot
            
            // Create the edit interface
            const blocks = this.modify.getCreator().getBlockBuilder();
            
            // Add title
            blocks.addSectionBlock({
                text: {
                    type: TextObjectType.MARKDOWN,
                    text: '*Edit FAQ Response*'
                }
            });
            
            // Add divider
            blocks.addDividerBlock();
            
            // Add original question
            blocks.addSectionBlock({
                text: {
                    type: TextObjectType.MARKDOWN,
                    text: `*Original Question:*\n${review.originalMessage}`
                }
            });
            
            // Add detected FAQ
            blocks.addSectionBlock({
                text: {
                    type: TextObjectType.MARKDOWN,
                    text: `*Detected FAQ:*\n${review.detectedQuestion}`
                }
            });
            
            // Add current response in a text box for easy copying
            blocks.addSectionBlock({
                text: {
                    type: TextObjectType.MARKDOWN,
                    text: '*Current Response:*\n```\n' + review.proposedAnswer + '\n```'
                }
            });
            
            // Add instructions
            blocks.addSectionBlock({
                text: {
                    type: TextObjectType.MARKDOWN,
                    text: '📝 *To edit this response:*\n1. Copy the text above\n2. Reply with your edited version\n3. Click the "Send Edited Response" button below'
                }
            });
            
            // Add action buttons
            blocks.addActionsBlock({
                elements: [
                    blocks.newButtonElement({
                        text: {
                            type: TextObjectType.PLAINTEXT,
                            text: 'Send to Channel'
                        },
                        style: ButtonStyle.PRIMARY,
                        actionId: `${EditActionIds.SUBMIT_EDIT}_${review.reviewId}`,
                        value: review.reviewId
                    }),
                    blocks.newButtonElement({
                        text: {
                            type: TextObjectType.PLAINTEXT,
                            text: 'Cancel'
                        },
                        style: ButtonStyle.DANGER,
                        actionId: `${EditActionIds.CANCEL_EDIT}_${review.reviewId}`,
                        value: review.reviewId
                    })
                ]
            });
            
            // Send the message with blocks
            const messageBuilder = this.modify.getCreator().startMessage()
                .setRoom(room)
                .setBlocks(blocks);
            
            await this.modify.getCreator().finish(messageBuilder);
            
            this.log('debug', `Edit interface sent to user: ${user.username}`);
        } catch (error) {
            this.log('error', `Error handling edit action: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Handles the submit edit action
     * @param reviewId - The review ID
     * @param user - The user who submitted the edit
     */
    public async handleSubmitEdit(reviewId: string, user: IUser): Promise<void> {
        this.log('debug', `Handling submit edit for review: ${reviewId}`);
        
        try {
            // Get services
            const reviewManager = new ReviewManager(this.persistence, this.read.getPersistenceReader());
            const notificationService = new NotificationService(this.read, this.modify);
            
            // Get the review
            const review = await reviewManager.getReviewById(reviewId);
            if (!review) {
                this.log('error', `Review not found: ${reviewId}`);
                throw new Error(`Review not found: ${reviewId}`);
            }
            
            // Get the DM room with the user
            const room = await notificationService.getDMRoom(user);
            if (!room) {
                this.log('error', `Could not get DM room with user: ${user.username}`);
                throw new Error(`Could not get DM room with user: ${user.username}`);
            }
            
            // Send prompt to get edited text
            const messageBuilder = this.modify.getCreator().startMessage()
                .setRoom(room)
                .setText('Please reply with your edited response text. Once sent, I will update the FAQ response and send it to the original channel.');
            
            await this.modify.getCreator().finish(messageBuilder);
            
            // Note: At this point, we'd ideally read the user's next message
            // However, this isn't straightforward in Rocket.Chat Apps
            // The main FaqDetectionApp.ts will need to implement logic to
            // look for responses in DM channels with reviewers after a submit action
            
            this.log('debug', `Submit edit prompt sent to user: ${user.username}`);
        } catch (error) {
            this.log('error', `Error in handleSubmitEdit: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
    
    /**
     * Processes the final edited response
     * @param reviewId - The review ID 
     * @param user - The user submitting the edit
     * @param editedResponse - The edited response text
     */
    public async processEditedResponse(reviewId: string, user: IUser, editedResponse: string): Promise<void> {
        this.log('debug', `Processing edited response for review: ${reviewId}`);
        
        try {
            // Initialize services
            const reviewManager = new ReviewManager(this.persistence, this.read.getPersistenceReader());
            const notificationService = new NotificationService(this.read, this.modify);
            
            // Get the review
            const review = await reviewManager.getReviewById(reviewId);
            if (!review) {
                this.log('error', `Review not found: ${reviewId}`);
                throw new Error(`Review not found: ${reviewId}`);
            }
            
            // Update the review with the edited response
            const updatedReview = {
                ...review,
                proposedAnswer: editedResponse,
                status: ReviewStatus.APPROVED
            };
            
            // Save the updated review
            await this.updateReview(updatedReview);
            
            // Send the edited response to the original room
            await this.sendResponse(editedResponse, review.roomId);
            
            // Send confirmation to the reviewer
            await notificationService.sendActionConfirmation(
                updatedReview,
                user,
                'approve'
            );
            
            this.log('info', `Review ${reviewId} successfully edited and sent by ${user.username}`);
        } catch (error) {
            this.log('error', `Error processing edited response: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
    
    /**
     * Handles the cancel edit action
     * @param reviewId - The review ID
     * @param user - The user who canceled
     */
    public async handleCancelEdit(reviewId: string, user: IUser): Promise<void> {
        this.log('debug', `Handling cancel edit for review: ${reviewId}`);
        
        try {
            // Get services
            const notificationService = new NotificationService(this.read, this.modify);
            
            // Get the DM room with the user
            const room = await notificationService.getDMRoom(user);
            if (!room) {
                this.log('error', `Could not get DM room with user: ${user.username}`);
                throw new Error(`Could not get DM room with user: ${user.username}`);
            }
            
            // Send cancellation message
            const messageBuilder = this.modify.getCreator().startMessage()
                .setRoom(room)
                .setText('Edit canceled. No changes were made to the FAQ response.');
            
            await this.modify.getCreator().finish(messageBuilder);
            
            this.log('debug', `Cancel edit confirmation sent to user: ${user.username}`);
        } catch (error) {
            this.log('error', `Error in handleCancelEdit: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
    
    /**
     * Updates a review in the database
     * @param review - The updated review object
     */
    private async updateReview(review: Review): Promise<void> {
        this.log('debug', `Updating review: ${review.reviewId}`);
        
        try {
            // Create association for the review ID
            const reviewAssociation = new RocketChatAssociationRecord(
                RocketChatAssociationModel.MISC,
                `review:${review.reviewId}`
            );
            
            // Create association for the status
            const statusAssociation = new RocketChatAssociationRecord(
                RocketChatAssociationModel.MISC,
                `status:${review.status}`
            );
            
            // Remove old review
            await this.persistence.removeByAssociations([reviewAssociation]);
            
            // Store updated review
            await this.persistence.createWithAssociations(review, [reviewAssociation, statusAssociation]);
            
            this.log('debug', `Review updated successfully: ${review.reviewId}`);
        } catch (error) {
            this.log('error', `Error updating review: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
    
    /**
     * Sends a response to the specified room
     * @param text - The text to send
     * @param roomId - The ID of the room to send to
     */
    private async sendResponse(text: string, roomId: string): Promise<void> {
        this.log('debug', `Sending response to room: ${roomId}`);
        
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
            
            this.log('debug', `Response sent to room: ${roomId}`);
        } catch (error) {
            this.log('error', `Error sending response: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Logs a message with the appropriate log level
     */
    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        const prefix = '[EditActionHandler]';
        
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
            console.log(`${prefix} [${level.toUpperCase()}] ${message}`);
        }
    }
} 