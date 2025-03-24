import { IModify, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { IRoom, RoomType } from '@rocket.chat/apps-engine/definition/rooms';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { Review } from '../data/Review';
import { BlockBuilder } from '@rocket.chat/apps-engine/definition/uikit/blocks';
import { ButtonStyle } from '@rocket.chat/apps-engine/definition/uikit';
import { TextObjectType } from '@rocket.chat/apps-engine/definition/uikit/blocks/Objects';

/**
 * Service for sending notifications to reviewers
 */
export class NotificationService {
    /**
     * Creates a new NotificationService instance
     * @param read - The read accessor
     * @param modify - The modify accessor
     */
    constructor(
        private readonly read: IRead,
        private readonly modify: IModify
    ) {}

    /**
     * Sends a review notification to the specified reviewer
     * @param review - The review to send notification for
     * @param reviewer - The user to send the notification to
     * @returns Promise that resolves when the notification is sent
     */
    public async sendReviewNotification(review: Review, reviewer: IUser): Promise<void> {
        try {
            console.log(`[NotificationService] Starting sendReviewNotification for reviewer: ${reviewer.username}`);
            
            // Get or create a direct message room with the reviewer
            const room = await this.getDMRoom(reviewer);
            
            if (!room) {
                throw new Error(`Could not create or get DM room for reviewer ${reviewer.username}`);
            }
            
            // Create the notification message with UI elements
            const blocks = this.createReviewBlocks(review);
            
            // Send the message
            const messageBuilder = this.modify.getCreator().startMessage()
                .setRoom(room)
                .setBlocks(blocks);
                
            await this.modify.getCreator().finish(messageBuilder);
        } catch (error) {
            // Re-throw the error for the caller to handle
            throw new Error(`Failed to send review notification: ${error.message}`);
        }
    }

    /**
     * Sends a confirmation message to the reviewer after an action is taken
     * @param review - The review that was acted upon
     * @param reviewer - The reviewer who took the action
     * @param action - The action that was taken (approve/reject)
     * @returns Promise that resolves when the confirmation is sent
     */
    public async sendActionConfirmation(review: Review, reviewer: IUser, action: 'approve' | 'reject'): Promise<void> {
        try {
            console.log(`[NotificationService] Sending action confirmation for review: ${review.reviewId}, action: ${action}`);
            
            // Get the DM room with the reviewer
            console.log(`[NotificationService] Getting DM room for reviewer: ${reviewer.username}`);
            const room = await this.getDMRoom(reviewer);
            
            if (!room) {
                console.log(`[NotificationService] Failed to get DM room for reviewer: ${reviewer.username}`);
                throw new Error(`Could not get DM room for reviewer ${reviewer.username}`);
            }
            
            console.log(`[NotificationService] Got DM room: ${room.id}`);
            
            // Create the confirmation message
            let confirmationText = '';
            if (action === 'approve') {
                confirmationText = `✅ You approved the response to: "${review.originalMessage}"\n\nThe following response has been sent to the channel:\n\n${review.proposedAnswer}`;
            } else {
                confirmationText = `❌ You rejected the response to: "${review.originalMessage}"\n\nNo response has been sent to the channel.`;
            }
            
            console.log(`[NotificationService] Created confirmation text: ${confirmationText.substring(0, 50)}...`);
            
            // Send the message
            console.log(`[NotificationService] Creating message builder`);
            const messageBuilder = this.modify.getCreator().startMessage()
                .setRoom(room)
                .setText(confirmationText);
            
            console.log(`[NotificationService] Sending confirmation message`);    
            await this.modify.getCreator().finish(messageBuilder);
            console.log(`[NotificationService] Confirmation message sent successfully`);
        } catch (error) {
            // Re-throw the error for the caller to handle
            console.log(`[NotificationService] Error sending action confirmation: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to send action confirmation: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Gets or creates a direct message room with the specified user
     * @param user - The user to create a DM room with
     * @returns The DM room
     */
    public async getDMRoom(user: IUser): Promise<IRoom | undefined> {
        console.log(`[NotificationService] Getting or creating DM room for user: ${user.username}`);
        
        const roomBuilder = this.modify.getCreator().startRoom()
            .setType(RoomType.DIRECT_MESSAGE)
            .setCreator(user);
        
        console.log(`[NotificationService] Created room builder`);
        const roomId = await this.modify.getCreator().finish(roomBuilder);
        console.log(`[NotificationService] Got room ID: ${roomId}`);
        
        const room = await this.read.getRoomReader().getById(roomId);
        console.log(`[NotificationService] Retrieved room: ${room ? room.id : 'undefined'}`);
        
        return room;
    }

    /**
     * Creates UI blocks for the review notification
     * @param review - The review to create blocks for
     * @returns The UI blocks
     */
    private createReviewBlocks(review: Review): BlockBuilder {
        const blocks = this.modify.getCreator().getBlockBuilder();
        
        // Add header section
        blocks.addSectionBlock({
            text: {
                type: TextObjectType.MARKDOWN,
                text: `*New FAQ Response Review*`
            }
        });
        
        // Add divider
        blocks.addDividerBlock();
        
        // Add original message context
        blocks.addSectionBlock({
            text: {
                type: TextObjectType.MARKDOWN,
                text: `*Original Message:*\n${review.originalMessage}`
            }
        });
        
        // Add room context
        blocks.addContextBlock({
            elements: [
                {
                    type: TextObjectType.MARKDOWN,
                    text: `*Room:* ${review.roomName} | *From:* ${review.senderUsername}`
                }
            ]
        });
        
        // Add divider
        blocks.addDividerBlock();
        
        // Add detected question
        blocks.addSectionBlock({
            text: {
                type: TextObjectType.MARKDOWN,
                text: `*Detected FAQ:*\n${review.detectedQuestion}`
            }
        });
        
        // Add proposed answer
        blocks.addSectionBlock({
            text: {
                type: TextObjectType.MARKDOWN,
                text: `*Proposed Response:*\n${review.proposedAnswer}`
            }
        });
        
        // Add divider
        blocks.addDividerBlock();
        
        // Add action buttons
        blocks.addActionsBlock({
            elements: [
                blocks.newButtonElement({
                    text: {
                        type: TextObjectType.PLAINTEXT,
                        text: 'Approve'
                    },
                    style: ButtonStyle.PRIMARY,
                    actionId: `approve_${review.reviewId}`,
                    value: review.reviewId
                }),
                blocks.newButtonElement({
                    text: {
                        type: TextObjectType.PLAINTEXT,
                        text: 'Edit'
                    },
                    style: ButtonStyle.PRIMARY,
                    actionId: `edit_${review.reviewId}`,
                    value: review.reviewId
                }),
                blocks.newButtonElement({
                    text: {
                        type: TextObjectType.PLAINTEXT,
                        text: 'Reject'
                    },
                    style: ButtonStyle.DANGER,
                    actionId: `reject_${review.reviewId}`,
                    value: review.reviewId
                })
            ]
        });
        
        return blocks;
    }
} 