import { IModify, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { IRoom, RoomType } from '@rocket.chat/apps-engine/definition/rooms';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { Review } from '../data/Review';
import { BlockBuilder } from '@rocket.chat/apps-engine/definition/uikit/blocks';
import { TextObjectType } from '@rocket.chat/apps-engine/definition/uikit/blocks/Objects';
import { ButtonStyle } from '@rocket.chat/apps-engine/definition/uikit';

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
     * @param action - The action that was taken (approve/reject/edit/submit_edit/process_edit/cancel_edit)
     * @returns Promise that resolves when the confirmation is sent
     */
    public async sendActionConfirmation(review: Review, reviewer: IUser, action: 'approve' | 'reject' | 'edit' | 'submit_edit' | 'process_edit' | 'cancel_edit'): Promise<void> {
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
            
            // Create the confirmation blocks
            const blocks = this.modify.getCreator().getBlockBuilder();
            
            // Add appropriate icon and title based on action
            let icon = '';
            let title = '';
            let detailText = '';
            
            if (action === 'approve') {
                icon = '✅';
                title = 'Approved';
                detailText = `Your approval has been processed. The response has been sent to @${review.senderUsername} in #${review.roomName}.`;
            } else if (action === 'reject') {
                icon = '❌';
                title = 'Rejected';
                detailText = `Your rejection has been processed. No response has been sent to @${review.senderUsername}.`;
            } else if (action === 'edit') {
                icon = '✏️';
                title = 'Edit Mode';
                detailText = `Please reply with your edited version of the response. When finished, click the Submit button below.`;
                
                // Add the original response for reference
                blocks.addSectionBlock({
                    text: {
                        type: TextObjectType.MARKDOWN,
                        text: `*Original Response:*\n${review.proposedAnswer}`
                    }
                });
                
                // Add submit and cancel buttons
                blocks.addActionsBlock({
                    elements: [
                        blocks.newButtonElement({
                            text: {
                                type: TextObjectType.PLAINTEXT,
                                text: 'Submit Edit'
                            },
                            style: ButtonStyle.PRIMARY,
                            actionId: `submit_edit_${review.reviewId}`,
                            value: review.reviewId
                        }),
                        blocks.newButtonElement({
                            text: {
                                type: TextObjectType.PLAINTEXT,
                                text: 'Cancel'
                            },
                            style: ButtonStyle.DANGER,
                            actionId: `cancel_edit_${review.reviewId}`,
                            value: review.reviewId
                        })
                    ]
                });
            } else if (action === 'submit_edit') {
                icon = '📝';
                title = 'Edit Submitted';
                detailText = `Your edit has been submitted. Please provide your edited response in the chat.`;
            } else if (action === 'process_edit') {
                icon = '✅';
                title = 'Edit Processed';
                detailText = `Your edited response has been processed and sent to @${review.senderUsername} in #${review.roomName}.`;
            } else if (action === 'cancel_edit') {
                icon = '🚫';
                title = 'Edit Cancelled';
                detailText = `Your edit has been cancelled. The original review is still pending.`;
            }
            
            // Add the title section
            blocks.addSectionBlock({
                text: {
                    type: TextObjectType.MARKDOWN,
                    text: `${icon} *${title}*`
                }
            });
            
            // Add the details section if not an edit action (for edit, we already added content above)
            if (action !== 'edit') {
                blocks.addSectionBlock({
                    text: {
                        type: TextObjectType.MARKDOWN,
                        text: detailText
                    }
                });
            }
            
            // Send the message
            console.log(`[NotificationService] Creating message builder`);
            const messageBuilder = this.modify.getCreator().startMessage()
                .setRoom(room)
                .setBlocks(blocks);
            
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
        
        const appUser = await this.read.getUserReader().getAppUser();
        
        if (!appUser) {
            throw new Error('Could not get app user');
        }
        
        const roomBuilder = this.modify.getCreator().startRoom()
            .setType(RoomType.DIRECT_MESSAGE)
            .setCreator(appUser)
            .setMembersToBeAddedByUsernames([user.username]);
        
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
    public createReviewBlocks(review: Review): BlockBuilder {
        const blocks = this.modify.getCreator().getBlockBuilder();
        
        // Add original message
        blocks.addSectionBlock({
            text: {
                type: TextObjectType.MARKDOWN,
                text: `*Original Message:*
${review.originalMessage}`
            }
        });
        
        // Add room context
        blocks.addSectionBlock({
            text: {
                type: TextObjectType.MARKDOWN,
                text: `*From:* @${review.senderUsername} | *Channel:* #${review.roomName}`
            }
        });
        
        // Add proposed response
        blocks.addSectionBlock({
            text: {
                type: TextObjectType.MARKDOWN,
                text: `*Proposed Response by the LLM:*
${review.proposedAnswer}`
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