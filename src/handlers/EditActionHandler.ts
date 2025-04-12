import { ILogger, IModify, IPersistence, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { Review, ReviewStatus } from '../data/Review';
import { ReviewManager } from '../services/ReviewManager';
import { NotificationService } from '../services/NotificationService';
import { IRoom } from '@rocket.chat/apps-engine/definition/rooms';
import { ButtonStyle, TextObjectType } from '@rocket.chat/apps-engine/definition/uikit/blocks';
import { IUIKitSurface, UIKitSurfaceType } from '@rocket.chat/apps-engine/definition/uikit';
import { ChannelService } from '../services/ChannelService';
import { getAPIConfig } from '../config/settings';
import { IMessage } from '@rocket.chat/apps-engine/definition/messages';

/**
 * Handler for edit actions on FAQ reviews
 */
export class EditActionHandler {
    /**
     * Creates a new EditActionHandler instance
     * @param read - The read accessor
     * @param persistence - The persistence accessor
     * @param modify - The modify accessor
     * @param logger - The logger
     */
    constructor(
        private readonly read: IRead,
        private readonly persistence: IPersistence,
        private readonly modify: IModify,
        private readonly logger: ILogger
    ) {}

    /**
     * Handles the edit action for a review
     * @param reviewId - The ID of the review to edit
     * @param user - The user who initiated the edit
     * @param triggerId - The trigger ID for opening the modal
     * @returns Promise that resolves when the action is handled
     */
    public async handleEditAction(reviewId: string, user: IUser, triggerId: string): Promise<void> {
        this.log('debug', `Starting edit action for review: ${reviewId}`);
        
        try {
            // Initialize services
            this.log('debug', `Initializing services`);
            const reviewManager = new ReviewManager(this.persistence, this.read.getPersistenceReader());
            
            // Get the review
            this.log('debug', `Retrieving review: ${reviewId}`);
            const reviewResult = await reviewManager.getReviewById(reviewId);
            
            if (!reviewResult) {
                this.log('error', `Review not found: ${reviewId}`);
                throw new Error('Review not found');
            }
            
            const review: Review = reviewResult;
            
            // Open the edit modal
            this.log('debug', `Opening edit modal for review: ${reviewId}`);
            await this.openEditModal(review, user, triggerId);
            
            // Update review status
            this.log('debug', `Updating review status to editing`);
            await reviewManager.updateReviewStatus(reviewId, ReviewStatus.EDITING);
            
            // Update log channel if enabled
            const config = await getAPIConfig(this.read);
            if (config.faqLogChannel) {
                try {
                    const channelService = new ChannelService(this.read, this.modify, this.logger);
                    const appUser = await this.read.getUserReader().getAppUser();
                    if (!appUser) {
                        this.log('error', 'Could not get app user for logging');
                        return;
                    }
                    
                    const logChannel = await channelService.getOrCreateLogChannel(
                        appUser,
                        config.faqLogChannel
                    );
                    
                    await channelService.updateLogMessageStatus(
                        logChannel,
                        reviewId,
                        'editing',
                        user
                    );
                } catch (error) {
                    this.log('error', `Error updating log channel: ${error instanceof Error ? error.message : String(error)}`);
                    this.log('error', `Stack trace: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
                }
            }
        } catch (error) {
            this.log('error', `Error handling edit action: ${error instanceof Error ? error.message : String(error)}`);
            this.log('error', `Stack trace: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
            throw error;
        }
    }

    /**
     * Opens the edit modal for a review
     * @param review - The review to edit
     * @param user - The user who is editing
     * @param triggerId - The trigger ID for opening the modal
     * @returns Promise that resolves when the modal is opened
     */
    private async openEditModal(review: Review, user: IUser, triggerId: string): Promise<void> {
        this.log('debug', `Creating edit modal for review: ${review.reviewId}`);
        
        // Create the modal
        const modal = this.createEditModal(review);
        
        // Show the modal
        this.log('debug', `Showing modal to user: ${user.username}`);
        await this.modify.getUiController().openSurfaceView(modal, { triggerId }, user);
    }

    /**
     * Creates the edit modal for a review
     * @param review - The review to edit
     * @returns The modal surface
     */
    private createEditModal(review: Review): IUIKitSurface {
        this.log('debug', `Building modal UI for review: ${review.reviewId}`);
        
        const blocks = this.modify.getCreator().getBlockBuilder();
        
        // Add original message
        blocks.addSectionBlock({
            text: {
                type: TextObjectType.MARKDOWN,
                text: `*Original Message:*\n${review.originalMessage}`
            }
        });
        
        // Add divider
        blocks.addDividerBlock();
        
        // Add text input for editing the proposed answer
        blocks.addInputBlock({
            blockId: 'edit_answer_block',
            element: blocks.newPlainTextInputElement({
                actionId: 'edit_answer_input',
                initialValue: review.proposedAnswer,
                multiline: true
            }),
            label: {
                type: TextObjectType.PLAINTEXT,
                text: 'Edit Proposed Answer'
            }
        });
        
        // Store the review ID in a hidden state field
        blocks.addInputBlock({
            blockId: 'review_id_block',
            optional: true,
            element: blocks.newPlainTextInputElement({
                actionId: 'review_id_input',
                initialValue: review.reviewId,
                multiline: false
            }),
            label: {
                type: TextObjectType.PLAINTEXT,
                text: 'Review ID (Do not edit)'
            }
        });
        
        // Create the modal with standard buttons
        const modal: IUIKitSurface = {
            id: `edit_modal_${review.reviewId}`,
            type: UIKitSurfaceType.MODAL,
            title: {
                type: TextObjectType.PLAINTEXT,
                text: 'Edit FAQ Response'
            },
            blocks: blocks.getBlocks(),
            close: blocks.newButtonElement({
                text: blocks.newPlainTextObject('Cancel'),
                actionId: 'cancel'
            }),
            submit: blocks.newButtonElement({
                text: blocks.newPlainTextObject('Submit'),
                actionId: 'submit'
            }),
            appId: 'faq-detection-app'
        };
        
        this.log('debug', `Modal created with ID: ${modal.id}`);
        return modal;
    }

    /**
     * Handles the cancellation of an edit
     * @param reviewId - ID of the review being edited
     * @param user - User who cancelled the edit
     */
    public async handleCancelEdit(reviewId: string, user: IUser): Promise<void> {
        try {
            this.log('debug', `Handling cancel edit for review: ${reviewId} by user: ${user.id}`);
            
            // Get the review
            const reviewManager = new ReviewManager(this.persistence, this.read.getPersistenceReader());
            const review = await reviewManager.getReviewById(reviewId);
            
            if (!review) {
                this.log('error', `Review not found for ID: ${reviewId}`);
                return;
            }
            
            // Log the cancellation
            this.log('info', `Edit cancelled for review: ${reviewId} by user: ${user.username}`);
            
            // Send confirmation to the user
            const notificationService = new NotificationService(this.read, this.modify);
            await notificationService.sendActionConfirmation(review, user, 'cancel_edit');
            
        } catch (error) {
            this.log('error', `Error handling cancel edit: ${error instanceof Error ? error.message : String(error)}`);
            this.log('error', `Stack trace: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
        }
    }

    /**
     * Handles the submission of an edited response
     * @param reviewId - ID of the review being edited
     * @param user - User who submitted the edit
     * @param editedAnswer - The edited answer
     */
    public async handleSubmitEdit(reviewId: string, user: IUser, editedAnswer: string): Promise<void> {
        try {
            this.log('debug', `Handling submit edit for review: ${reviewId} by user: ${user.id}`);
            
            // Get the review
            const reviewManager = new ReviewManager(this.persistence, this.read.getPersistenceReader());
            const review = await reviewManager.getReviewById(reviewId);
            
            if (!review) {
                this.log('error', `Review not found for ID: ${reviewId}`);
                throw new Error(`Review not found for ID: ${reviewId}`);
            }
            
            // Update the review with the edited answer
            await reviewManager.updateReviewAnswer(reviewId, editedAnswer);
            
            // Process the edited response
            await this.processEditedResponse(reviewId, user);
            
            this.log('info', `Edit submitted for review: ${reviewId} by user: ${user.username}`);
            
        } catch (error) {
            this.log('error', `Error handling submit edit: ${error instanceof Error ? error.message : String(error)}`);
            this.log('error', `Stack trace: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
            throw error;
        }
    }

    /**
     * Processes the edited response for a review
     * @param reviewId - The ID of the review
     * @param user - The user who edited the review
     * @returns Promise that resolves when the processing is complete
     */
    public async processEditedResponse(reviewId: string, user: IUser): Promise<void> {
        this.log('debug', `Processing edited response for review: ${reviewId}`);
        
        try {
            // Initialize services
            const reviewManager = new ReviewManager(this.persistence, this.read.getPersistenceReader());
            const notificationService = new NotificationService(this.read, this.modify);
            
            // Get the review
            const review = await reviewManager.getReviewById(reviewId);
            
            if (!review) {
                this.log('error', `Review not found for ID: ${reviewId}`);
                throw new Error(`Review not found for ID: ${reviewId}`);
            }
            
            // Get the source room
            const roomReader = this.read.getRoomReader();
            const sourceRoomResult = await roomReader.getById(review.roomId);
            
            if (!sourceRoomResult) {
                this.log('error', `Source room not found: ${review.roomId}`);
                throw new Error(`Source room not found: ${review.roomId}`);
            }
            
            const sourceRoom: IRoom = sourceRoomResult;
            
            // Get the sender
            const userReader = this.read.getUserReader();
            const senderResult = await userReader.getById(review.senderId);
            
            if (!senderResult) {
                this.log('error', `Sender not found: ${review.senderId}`);
                throw new Error(`Sender not found: ${review.senderId}`);
            }
            
            const sender: IUser = senderResult;
            
            // Get the original message to determine if it has a thread
            const messageReader = this.read.getMessageReader();
            const originalMessageResult = await messageReader.getById(review.messageId);
            
            // Send the edited response to the source room
            // Note: originalMessageResult might be undefined, but that's okay because we handle it in sendResponseToRoom
            await this.sendResponseToRoom(sourceRoom, sender, review.proposedAnswer, originalMessageResult?.threadId);
            
            // Update review status to APPROVED
            await reviewManager.updateReviewStatus(reviewId, ReviewStatus.APPROVED);
            
            // Update log channel if enabled
            const config = await getAPIConfig(this.read);
            if (config.faqLogChannel) {
                try {
                    const channelService = new ChannelService(this.read, this.modify, this.logger);
                    const appUser = await this.read.getUserReader().getAppUser();
                    if (!appUser) {
                        this.log('error', 'Could not get app user for logging');
                        return;
                    }
                    
                    const logChannel = await channelService.getOrCreateLogChannel(
                        appUser,
                        config.faqLogChannel
                    );
                    
                    await channelService.updateLogMessageStatus(
                        logChannel,
                        reviewId,
                        'edited',
                        user
                    );
                } catch (error) {
                    this.log('error', `Error updating log channel: ${error instanceof Error ? error.message : String(error)}`);
                    this.log('error', `Stack trace: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
                }
            }
            
            // Send confirmation to the reviewer
            await notificationService.sendActionConfirmation(review, user, 'process_edit');
            
            this.log('debug', `Edited response processed successfully for review: ${reviewId}`);
        } catch (error) {
            this.log('error', `Error processing edited response: ${error instanceof Error ? error.message : String(error)}`);
            this.log('error', `Stack trace: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
            throw error;
        }
    }

    /**
     * Sends a response to a room
     * @param room - The room to send the response to
     * @param sender - The original message sender
     * @param responseText - The response text to send
     * @param threadId - The thread ID to use for the response
     * @returns Promise that resolves when the message is sent
     */
    private async sendResponseToRoom(room: IRoom, sender: IUser, responseText: string, threadId?: string): Promise<void> {
        this.log('debug', `Sending response to room: ${room.id}`);
        
        const messageBuilder = this.modify.getCreator().startMessage()
            .setRoom(room)
            .setText(responseText);
            
        // Set the sender as the thread parent if the original message has a thread
        if (threadId) {
            messageBuilder.setThreadId(threadId);
        }
        
        await this.modify.getCreator().finish(messageBuilder);
        
        this.log('debug', `Response sent to room: ${room.id}`);
    }

    /**
     * Logs a message with the specified level
     * @param level - The log level
     * @param message - The message to log
     */
    private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
        if (!this.logger) {
            return;
        }
        
        switch (level) {
            case 'debug':
                this.logger.debug(`[EditActionHandler] ${message}`);
                break;
            case 'info':
                this.logger.info(`[EditActionHandler] ${message}`);
                break;
            case 'warn':
                this.logger.warn(`[EditActionHandler] ${message}`);
                break;
            case 'error':
                this.logger.error(`[EditActionHandler] ${message}`);
                break;
        }
    }
}
