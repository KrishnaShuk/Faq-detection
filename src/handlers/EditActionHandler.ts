import { ILogger, IModify, IPersistence, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { ReviewStatus } from '../data/Review';
import { ReviewManager } from '../services/ReviewManager';
import { NotificationService } from '../services/NotificationService';
import { IRoom } from '@rocket.chat/apps-engine/definition/rooms';
import { ButtonStyle, TextObjectType } from '@rocket.chat/apps-engine/definition/uikit/blocks';
import { IUIKitSurface, UIKitSurfaceType } from '@rocket.chat/apps-engine/definition/uikit';
import { ChannelService } from '../services/ChannelService';
import { getAPIConfig } from '../config/settings';

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
    public async handleEditAction(reviewId: string, user: IUser, triggerId?: string): Promise<void> {
        this.log('debug', `Starting edit action for review: ${reviewId}`);
        
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
            
            // Update review status to EDITING
            this.log('debug', `Updating review status to EDITING`);
            await reviewManager.updateReviewStatus(reviewId, ReviewStatus.EDITING);
            
            // Send confirmation to the reviewer
            this.log('debug', `Sending confirmation to reviewer: ${user.username}`);
            await notificationService.sendActionConfirmation(review, user, 'edit');
            
            // Open edit modal if triggerId is provided
            if (triggerId) {
                this.log('debug', `Opening edit modal with triggerId: ${triggerId}`);
                await this.openEditModal(review, user, triggerId);
            }
            
            this.log('debug', `Edit action completed successfully for review: ${reviewId}`);
        } catch (error) {
            this.log('error', `Error handling edit action: ${error instanceof Error ? error.message : String(error)}`);
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
    private async openEditModal(review: any, user: IUser, triggerId: string): Promise<void> {
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
    private createEditModal(review: any): IUIKitSurface {
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
        
        // Create the modal
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
                actionId: `cancel_edit_${review.reviewId}`
            }),
            submit: blocks.newButtonElement({
                text: blocks.newPlainTextObject('Submit'),
                actionId: `submit_edit_${review.reviewId}`
            }),
            appId: 'faq-detection-app'
        };
        
        return modal;
    }

    /**
     * Handles the submit edit action for a review
     * @param reviewId - The ID of the review to submit edit for
     * @param user - The user who submitted the edit
     * @param editedAnswer - The edited answer text
     * @returns Promise that resolves when the action is handled
     */
    public async handleSubmitEdit(reviewId: string, user: IUser, editedAnswer?: string): Promise<void> {
        this.log('debug', `Starting submit edit action for review: ${reviewId}`);
        
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
            
            // If we have an edited answer, update the review
            if (editedAnswer) {
                this.log('debug', `Updating review with edited answer`);
                await reviewManager.updateReviewAnswer(reviewId, editedAnswer);
            }
            
            // Process the edited response
            await this.processEditedResponse(reviewId, user);
            
            // Send confirmation to the reviewer
            this.log('debug', `Sending edit submission confirmation to reviewer: ${user.username}`);
            await notificationService.sendActionConfirmation(review, user, 'submit_edit');
            
            this.log('debug', `Submit edit action completed successfully for review: ${reviewId}`);
        } catch (error) {
            this.log('error', `Error handling submit edit action: ${error instanceof Error ? error.message : String(error)}`);
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
                this.log('error', `Review not found: ${reviewId}`);
                throw new Error(`Review not found: ${reviewId}`);
            }
            
            // Get the source room
            const roomReader = this.read.getRoomReader();
            const sourceRoom = await roomReader.getById(review.roomId);
            
            if (!sourceRoom) {
                this.log('error', `Source room not found: ${review.roomId}`);
                throw new Error(`Source room not found: ${review.roomId}`);
            }
            
            // Get the sender
            const userReader = this.read.getUserReader();
            const sender = await userReader.getById(review.senderId);
            
            if (!sender) {
                this.log('error', `Sender not found: ${review.senderId}`);
                throw new Error(`Sender not found: ${review.senderId}`);
            }
            
            // Send the edited response to the source room
            await this.sendResponseToRoom(sourceRoom, sender, review.proposedAnswer);
            
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
                }
            }
            
            // Send confirmation to the reviewer
            await notificationService.sendActionConfirmation(review, user, 'process_edit');
            
            this.log('debug', `Edited response processed successfully for review: ${reviewId}`);
        } catch (error) {
            this.log('error', `Error processing edited response: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Handles the cancel edit action for a review
     * @param reviewId - The ID of the review
     * @param user - The user who cancelled the edit
     * @returns Promise that resolves when the action is handled
     */
    public async handleCancelEdit(reviewId: string, user: IUser): Promise<void> {
        this.log('debug', `Starting cancel edit action for review: ${reviewId}`);
        
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
            
            // Update review status back to PENDING
            await reviewManager.updateReviewStatus(reviewId, ReviewStatus.PENDING);
            
            // Send confirmation to the reviewer
            await notificationService.sendActionConfirmation(review, user, 'cancel_edit');
            
            this.log('debug', `Cancel edit action completed successfully for review: ${reviewId}`);
        } catch (error) {
            this.log('error', `Error handling cancel edit action: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Sends a response to a room
     * @param room - The room to send the response to
     * @param sender - The original message sender
     * @param responseText - The response text to send
     * @returns Promise that resolves when the message is sent
     */
    private async sendResponseToRoom(room: IRoom, sender: IUser, responseText: string): Promise<void> {
        this.log('debug', `Sending response to room: ${room.id}`);
        
        const messageBuilder = this.modify.getCreator().startMessage()
            .setRoom(room)
            .setText(responseText);
            
        // Set the sender as the thread parent if the original message has a thread
        if (sender.id) {
            messageBuilder.setThreadId(sender.id);
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
