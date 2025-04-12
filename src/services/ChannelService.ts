import { IModify, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { IRoom, RoomType } from '@rocket.chat/apps-engine/definition/rooms';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import { BlockBuilder } from '@rocket.chat/apps-engine/definition/uikit/blocks';
import { TextObjectType } from '@rocket.chat/apps-engine/definition/uikit/blocks/Objects';
import { MessageType } from './MessageClassifier';

/**
 * Service for managing the FAQ log channel
 */
export class ChannelService {
    /**
     * Creates a new ChannelService instance
     * @param read - The read accessor
     * @param modify - The modify accessor
     * @param logger - Logger instance
     */
    constructor(
        private readonly read: IRead,
        private readonly modify: IModify,
        private readonly logger: ILogger
    ) {}

    /**
     * Gets or creates the FAQ log channel
     * @param creator - The user who will be set as the channel creator
     * @param channelName - The name to use for the channel
     * @returns The channel room
     */
    public async getOrCreateLogChannel(creator: IUser, channelName: string): Promise<IRoom> {
        this.logger.debug(`[ChannelService] Getting or creating log channel: ${channelName}`);
        
        try {
            // Try to find the channel first by name
            const roomReader = this.read.getRoomReader();
            let existingRoom = await roomReader.getByName(channelName);
            
            // If not found by name, try by slugified name
            if (!existingRoom) {
                const slugifiedName = channelName.toLowerCase().replace(/\s+/g, '-');
                this.logger.debug(`[ChannelService] Channel not found by name, trying slugified name: ${slugifiedName}`);
                existingRoom = await roomReader.getByName(slugifiedName);
            }
            
            if (existingRoom) {
                this.logger.debug(`[ChannelService] Found existing channel: ${existingRoom.id}`);
                return existingRoom;
            }
            
            // Channel doesn't exist, create it
            this.logger.debug(`[ChannelService] Channel not found, creating new channel`);
            
            const roomBuilder = this.modify.getCreator().startRoom();
            roomBuilder.setType(RoomType.CHANNEL);
            roomBuilder.setCreator(creator);
            roomBuilder.setDisplayName(channelName);
            
            // Ensure the slugified name is valid
            const slugifiedName = channelName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            this.logger.debug(`[ChannelService] Using slugified name: ${slugifiedName}`);
            roomBuilder.setSlugifiedName(slugifiedName);
            
            // Make the channel public
            roomBuilder.setReadOnly(false);
            roomBuilder.setDefault(false);
            
            // Create the channel
            const roomId = await this.modify.getCreator().finish(roomBuilder);
            this.logger.debug(`[ChannelService] Created new channel with ID: ${roomId}`);
            
            if (!roomId) {
                throw new Error('Failed to create channel: No room ID returned');
            }
            
            // Get the created room
            const createdRoom = await roomReader.getById(roomId);
            
            if (!createdRoom) {
                throw new Error(`Failed to retrieve created channel with ID: ${roomId}`);
            }
            
            // Send an initial welcome message to the channel
            await this.sendInitialMessage(createdRoom);
            
            return createdRoom;
        } catch (error) {
            this.logger.error(`[ChannelService] Error creating log channel: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`Failed to create log channel: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Logs a message to the FAQ log channel
     * @param logChannel - The log channel to post to
     * @param messageType - The type of message (alpha/beta)
     * @param originalMessage - The original message text
     * @param sender - The user who sent the original message
     * @param sourceRoom - The room where the original message was sent
     * @param matchInfo - Additional information about the match
     * @param reviewer - The reviewer assigned to this message (for Beta messages)
     * @returns Promise that resolves when the log message is sent
     */
    public async logMessage(
        logChannel: IRoom,
        messageType: MessageType,
        originalMessage: string,
        sender: IUser,
        sourceRoom: IRoom,
        matchInfo: {
            score: number,
            matchedQuestion?: string,
            proposedAnswer?: string,
            reviewId?: string
        },
        reviewer?: IUser
    ): Promise<void> {
        try {
            this.logger.debug(`[ChannelService] Logging ${messageType} message to channel: ${logChannel.id}`);
            
            if (!logChannel) {
                throw new Error('Log channel is undefined or null');
            }
            
            // Validate that the log channel exists and is accessible
            const roomReader = this.read.getRoomReader();
            const verifiedChannel = await roomReader.getById(logChannel.id);
            
            if (!verifiedChannel) {
                throw new Error(`Could not verify log channel with ID: ${logChannel.id}`);
            }
            
            // Create message blocks
            const blocks = this.createLogMessageBlocks(
                messageType,
                originalMessage,
                sender,
                sourceRoom,
                matchInfo,
                reviewer
            );
            
            if (!blocks) {
                throw new Error('Failed to create message blocks');
            }
            
            // Send the message
            const messageBuilder = this.modify.getCreator().startMessage()
                .setRoom(verifiedChannel);
                
            // Add blocks if available
            if (blocks.getBlocks().length > 0) {
                messageBuilder.setBlocks(blocks);
            } else {
                // Fallback to plain text if blocks are empty
                const typeLabel = messageType === MessageType.ALPHA ? 'Direct FAQ Match' : 'LLM-Generated Response';
                messageBuilder.setText(`[${typeLabel}] Message from ${sender.username} in ${sourceRoom.displayName || sourceRoom.slugifiedName || 'unknown room'}`);
            }
            
            // Send the message and get the message ID
            const messageId = await this.modify.getCreator().finish(messageBuilder);
            
            if (!messageId) {
                throw new Error('Failed to send log message: No message ID returned');
            }
            
            this.logger.debug(`[ChannelService] Message logged successfully with ID: ${messageId}`);
            
            // If this is a review message, store the message ID for later updates
            if (messageType === MessageType.BETA && matchInfo.reviewId) {
                this.logger.debug(`[ChannelService] Storing log message ID for review: ${matchInfo.reviewId}`);
                // Implementation for storing message ID could be added here
            }
        } catch (error) {
            this.logger.error(`[ChannelService] Error logging message: ${error instanceof Error ? error.message : String(error)}`);
            this.logger.error(`[ChannelService] Stack trace: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
            throw error; // Re-throw to allow caller to handle
        }
    }

    /**
     * Updates a log message with review status
     * @param logChannel - The log channel
     * @param reviewId - The ID of the review
     * @param status - The new status
     * @param reviewer - The reviewer who took the action
     * @returns Promise that resolves when the update is complete
     */
    public async updateLogMessageStatus(
        logChannel: IRoom,
        reviewId: string,
        status: 'approved' | 'rejected' | 'edited' | 'editing' | 'pending',
        reviewer: IUser
    ): Promise<void> {
        // This would require finding the original message and updating it
        // For simplicity, we'll just post a new status update message
        
        const statusEmoji = {
            approved: '\u2705',
            rejected: '\u274c',
            edited: '\u270f\ufe0f',
            editing: '\u270f\ufe0f',
            pending: '\u23f3'
        }[status];
        
        const statusText = `${statusEmoji} Review **${reviewId}** was **${status}** by @${reviewer.username}`;
        
        const messageBuilder = this.modify.getCreator().startMessage()
            .setRoom(logChannel)
            .setText(statusText);
            
        await this.modify.getCreator().finish(messageBuilder);
    }

    /**
     * Sends an initial welcome message to a newly created log channel
     * @param channel - The channel to send the message to
     */
    private async sendInitialMessage(channel: IRoom): Promise<void> {
        const blocks = this.modify.getCreator().getBlockBuilder();
        
        blocks.addSectionBlock({
            text: {
                type: TextObjectType.MARKDOWN,
                text: `# 📊 FAQ Bot Log Channel

This channel logs all FAQ detection activity:

- 🟢 **Alpha Messages**: Direct matches to FAQs (answered automatically)
- 🟡 **Beta Messages**: Potential matches requiring review

Reviewers will be notified via DM when their action is needed.`
            }
        });
        
        const messageBuilder = this.modify.getCreator().startMessage()
            .setRoom(channel)
            .setBlocks(blocks);
            
        await this.modify.getCreator().finish(messageBuilder);
    }

    /**
     * Creates UI blocks for a log message
     * @param messageType - The type of message
     * @param originalMessage - The original message text
     * @param sender - The sender of the original message
     * @param sourceRoom - The room where the message was sent
     * @param matchInfo - Information about the match
     * @param reviewer - The reviewer assigned to this message (for Beta messages)
     * @returns BlockBuilder with the message blocks
     */
    private createLogMessageBlocks(
        messageType: MessageType,
        originalMessage: string,
        sender: IUser,
        sourceRoom: IRoom,
        matchInfo: {
            score: number,
            matchedQuestion?: string,
            proposedAnswer?: string,
            reviewId?: string
        },
        reviewer?: IUser
    ): BlockBuilder {
        const blocks = this.modify.getCreator().getBlockBuilder();
        
        if (messageType === MessageType.ALPHA) {
            // Alpha message format with green circle
            blocks.addSectionBlock({
                text: {
                    type: TextObjectType.MARKDOWN,
                    text: `🟢 **[Direct Match]**`
                }
            });
            
            // Add metadata (From, Room, Score)
            blocks.addContextBlock({
                elements: [
                    {
                        type: TextObjectType.MARKDOWN,
                        text: `**From:** @${sender.username} | **Room:** #${sourceRoom.displayName || sourceRoom.slugifiedName} | **Score:** ${matchInfo.score.toFixed(2)}`
                    }
                ]
            });
            
            // Add original user message
            blocks.addSectionBlock({
                text: {
                    type: TextObjectType.MARKDOWN,
                    text: `**User Message:**\n>${originalMessage}`
                }
            });
            
            // Add response
            if (matchInfo.proposedAnswer) {
                blocks.addSectionBlock({
                    text: {
                        type: TextObjectType.MARKDOWN,
                        text: `**Response Given:**\n${matchInfo.proposedAnswer}`
                    }
                });
            }
        } else {
            // Beta message format with yellow circle
            blocks.addSectionBlock({
                text: {
                    type: TextObjectType.MARKDOWN,
                    text: `🟡 **[Review Needed]**`
                }
            });
            
            // Add metadata (From, Room, Score)
            blocks.addContextBlock({
                elements: [
                    {
                        type: TextObjectType.MARKDOWN,
                        text: `**From:** @${sender.username} | **Room:** #${sourceRoom.displayName || sourceRoom.slugifiedName} | **Score:** ${matchInfo.score.toFixed(2)}`
                    }
                ]
            });
            
            // Add original user message
            blocks.addSectionBlock({
                text: {
                    type: TextObjectType.MARKDOWN,
                    text: `**User Message:**\n>${originalMessage}`
                }
            });
            
            // Add proposed response
            if (matchInfo.proposedAnswer) {
                blocks.addSectionBlock({
                    text: {
                        type: TextObjectType.MARKDOWN,
                        text: `**Proposed Response:**\n${matchInfo.proposedAnswer}`
                    }
                });
            }
            
            // Add reviewer assigned information in the main flow
            if (reviewer) {
                blocks.addSectionBlock({
                    text: {
                        type: TextObjectType.MARKDOWN,
                        text: `**Reviewer:** @${reviewer.username}`
                    }
                });
            }
            
            // Add review ID and status
            if (matchInfo.reviewId) {
                blocks.addContextBlock({
                    elements: [
                        {
                            type: TextObjectType.MARKDOWN,
                            text: `**Review ID:** ${matchInfo.reviewId} | **Status:** Pending Review`
                        }
                    ]
                });
            }
        }
        
        return blocks;
    }
}
