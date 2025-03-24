import {
    IAppAccessors,
    IConfigurationExtend,
    IHttp,
    ILogger,
    IModify,
    IPersistence,
    IRead,
} from '@rocket.chat/apps-engine/definition/accessors';
import { App } from '@rocket.chat/apps-engine/definition/App';
import { IAppInfo, RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';
import { IMessage, IPostMessageSent } from '@rocket.chat/apps-engine/definition/messages';
import { 
    IUIKitInteractionHandler, 
    UIKitActionButtonInteractionContext,
    IUIKitResponse,
    UIKitViewSubmitInteractionContext,
    UIKitBlockInteractionContext,
    UIKitViewCloseInteractionContext
} from '@rocket.chat/apps-engine/definition/uikit';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { RoomType } from '@rocket.chat/apps-engine/definition/rooms';

// App-specific imports
import { LogLevel } from '../helpers/LogLevel';
import { getAPIConfig, settings } from '../config/settings';
import { faqs } from '../data/faqs';
import { ReviewStatus } from '../data/Review';
import { LLMService } from '../services/llmService'; 
import { ReviewManager } from '../services/ReviewManager';
import { NotificationService } from '../services/NotificationService';
import { ApproveActionHandler } from '../handlers/ApproveActionHandler';
import { RejectActionHandler } from '../handlers/RejectActionHandler';
import { EditActionHandler } from '../handlers/EditActionHandler';

export class FaqDetectionApp extends App implements IPostMessageSent, IUIKitInteractionHandler {
    // Track recently processed message IDs and content hashes to avoid duplicates
    private processedMessages: Set<string> = new Set();
    private processedContents: Map<string, number> = new Map();
    private isProcessingMessage: boolean = false;
    
    // Map to track reviews and related actions
    private actionMap: Map<string, { userId: string, timestamp: number, status: string }> = new Map();
    
    // Configuration
    private apiConfig: any = null;
    private reviewMode: boolean = true;
    private roomFaqs: any[] = [];
    private appLogger: ILogger;
    
    constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
        super(info, logger, accessors);
        this.appLogger = logger;
        logger.debug('FAQ Detection App initialized');
    }

    /**
     * Process a button click action
     */
    public async executeActionButtonInteraction(
        context: UIKitActionButtonInteractionContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify
    ): Promise<IUIKitResponse> {
        this.log(LogLevel.DEBUG, 'ActionButton interaction received');
        
        try {
            const { actionId, triggerId, user } = context.getInteractionData();
            
            // Parse the action ID to get the action type and review ID
            const actionParts = actionId.split('_');
            if (actionParts.length < 2) {
                this.log(LogLevel.ERROR, `Invalid action ID format: ${actionId}`);
                return context.getInteractionResponder().errorResponse();
            }
            
            const action = actionParts[0];
            const reviewId = actionParts[actionParts.length - 1];
            
            this.log(LogLevel.DEBUG, `Processing action: ${action} for review: ${reviewId}`);
            
            // Handle different action types
            if (action === 'approve') {
                // Create and execute the approve action handler
                const approveHandler = new ApproveActionHandler(read, persistence, modify, this.appLogger);
                await approveHandler.handleApproveAction(reviewId, user);
                
                this.log(LogLevel.INFO, `Review ${reviewId} approved by ${user.username}`);
                
                // Clean up the action map
                this.deleteAction(reviewId);
                
            } else if (action === 'reject') {
                // Create and execute the reject action handler
                const rejectHandler = new RejectActionHandler(read, persistence, modify, this.appLogger);
                await rejectHandler.handleRejectAction(reviewId, user);
                
                this.log(LogLevel.INFO, `Review ${reviewId} rejected by ${user.username}`);
                
                // Clean up the action map
                this.deleteAction(reviewId);
                
            } else if (action === 'edit') {
                // Create and execute the edit action handler
                const editHandler = new EditActionHandler(read, persistence, modify, this.appLogger);
                await editHandler.handleEditAction(reviewId, user);
                
                this.log(LogLevel.INFO, `Edit interface displayed for review ${reviewId} by ${user.username}`);
                
                // Store user in action map for handling their response
                this.updateActionMap(reviewId, user.id, 'waiting_for_edit');
                
            } else if (action === 'submit' && actionParts[1] === 'edit') {
                // Handle the submit_edit action
                const editHandler = new EditActionHandler(read, persistence, modify, this.appLogger);
                await editHandler.handleSubmitEdit(reviewId, user);
                
                this.log(LogLevel.INFO, `Edit submission initiated for review ${reviewId} by ${user.username}`);
                
                // Update the action map to indicate we're waiting for a text response
                this.updateActionMap(reviewId, user.id, 'waiting_for_edit_text');
                
            } else if (action === 'cancel' && actionParts[1] === 'edit') {
                // Handle the cancel_edit action
                const editHandler = new EditActionHandler(read, persistence, modify, this.appLogger);
                await editHandler.handleCancelEdit(reviewId, user);
                
                this.log(LogLevel.INFO, `Edit canceled for review ${reviewId} by ${user.username}`);
                
                // Clean up the action map
                this.deleteAction(reviewId);
                
            } else {
                this.log(LogLevel.ERROR, `Unknown action type: ${action}`);
                return context.getInteractionResponder().errorResponse();
            }
            
            return context.getInteractionResponder().successResponse();
        } catch (error) {
            this.log(LogLevel.ERROR, `Error processing action button: ${error instanceof Error ? error.message : String(error)}`);
            return context.getInteractionResponder().errorResponse();
        }
    }

    /**
     * Process incoming messages to check for responses to edit prompts
     */
    public async executePostMessageSent(
        message: IMessage,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify
    ): Promise<void> {
        // Set processing lock to prevent concurrent processing
        if (this.isProcessingMessage) {
            this.log(LogLevel.DEBUG, 'Already processing a message, skipping this one');
            return;
        }
        
        this.isProcessingMessage = true;
        
        try {
            // Skip messages from the app itself
            const appUser = await read.getUserReader().getAppUser();
            if (message.sender?.id === appUser?.id) {
                this.log(LogLevel.DEBUG, 'Skipping message from the app itself');
                this.isProcessingMessage = false;
                return;
            }
            
            // Check if this is a response to an edit prompt in a DM
            const isDmResponse = await this.checkForEditResponse(message, read, persistence, modify);
            if (isDmResponse) {
                this.log(LogLevel.DEBUG, 'Processed message as an edit response');
                this.isProcessingMessage = false;
                return;
            }
            
            // Get the text from the message
            const text = message.text || '';
            if (!text.trim()) {
                this.log(LogLevel.DEBUG, 'Message has no text, skipping');
                this.isProcessingMessage = false;
                return;
            }
            
            // Create a unique identifier for this message
            const messageId = message.id;
            const contentHash = this.createContentHash(text);
            const uniqueId = `${messageId}-${contentHash}`;
            
            // Record this message but don't check for duplicates (duplicate detection disabled)
            this.log(LogLevel.DEBUG, `Processing message with ID: ${uniqueId} (duplicate detection disabled)`);
            this.processedContents.set(contentHash, Date.now());
            
            // Limit the size of the processedContents map
            if (this.processedContents.size > 100) {
                // Remove the oldest entries to keep the map size manageable
                const entries = Array.from(this.processedContents.entries());
                entries.sort((a, b) => a[1] - b[1]); // Sort by timestamp
                
                const entriesToDelete = entries.slice(0, entries.length - 100);
                entriesToDelete.forEach(([key]) => this.processedContents.delete(key));
            }
            
            // Check if API configuration is valid
            const hasValidConfig = this.checkValidApiConfig();
            if (!hasValidConfig) {
                this.log(LogLevel.ERROR, 'Invalid API configuration');
                this.isProcessingMessage = false;
                return;
            }
            
            // Process the message to check against FAQs
            const llmService = new LLMService(http, this.apiConfig.apiKey, this.apiConfig.endpoint, this.apiConfig.modelType);
            const matchResult = await llmService.checkMessage(text, this.roomFaqs);
            
            if (matchResult.matched) {
                this.log(LogLevel.INFO, `Matched FAQ: ${matchResult.detectedQuestion || 'Unknown'}`);
                
                // Get room information
                const room = message.room;
                if (!room) {
                    this.log(LogLevel.ERROR, 'Room not found in message');
                    this.isProcessingMessage = false;
                    return;
                }
                
                // Check if review mode is enabled
                if (this.reviewMode) {
                    // Process in review mode, creating a review and notifying reviewers
                    await this.processInReviewMode(matchResult, message, read, persistence, modify);
                } else {
                    // Send response directly to the channel
                    const answer = matchResult.answer || 'No answer available';
                    await this.sendResponse(answer, room.id, modify, read);
                }
            } else {
                this.log(LogLevel.DEBUG, 'No FAQ match found for message');
            }
        } catch (error) {
            this.log(LogLevel.ERROR, `Error processing message: ${error instanceof Error ? error.message : String(error)}`);
            
            // Attempt to send an error message to the user
            try {
                if (message.room) {
                    const text = 'Sorry, there was an error processing your message.';
                    const messageBuilder = modify.getCreator().startMessage()
                        .setRoom(message.room)
                        .setText(text);
                    
                    await modify.getCreator().finish(messageBuilder);
                }
            } catch (sendError) {
                this.log(LogLevel.ERROR, `Error sending error message: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
            }
        } finally {
            this.isProcessingMessage = false;
        }
    }

    /**
     * Required by IUIKitInteractionHandler
     */
    public async executeViewSubmitHandler(
        context: UIKitViewSubmitInteractionContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify
    ): Promise<IUIKitResponse> {
        // Not implemented for this app
        return context.getInteractionResponder().successResponse();
    }

    /**
     * Required by IUIKitInteractionHandler
     */
    public async executeBlockActionHandler(
        context: UIKitBlockInteractionContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify
    ): Promise<IUIKitResponse> {
        // Not implemented for this app - handled through action button interactions
        return context.getInteractionResponder().successResponse();
    }

    /**
     * Required by IUIKitInteractionHandler
     */
    public async executeViewClosedHandler(
        context: UIKitViewCloseInteractionContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify
    ): Promise<IUIKitResponse> {
        // Not implemented for this app
        return context.getInteractionResponder().successResponse();
    }

    /**
     * Checks if a message is a response to an edit prompt and processes it
     */
    private async checkForEditResponse(
        message: IMessage,
        read: IRead,
        persistence: IPersistence,
        modify: IModify
    ): Promise<boolean> {
        try {
            // Get the sender user ID
            const senderId = message.sender?.id;
            if (!senderId) {
                return false;
            }
            
            // Check if this is a direct message
            const room = message.room;
            if (!room || room.type !== RoomType.DIRECT_MESSAGE) {
                return false;
            }
            
            // Check if we have any pending edit actions for this user
            const pendingEditAction = this.findPendingEditAction(senderId);
            if (!pendingEditAction || pendingEditAction.status !== 'waiting_for_edit_text') {
                return false;
            }
            
            this.log(LogLevel.DEBUG, `Found pending edit for review ${pendingEditAction.reviewId} from user ${senderId}`);
            
            // Process the edited text
            const editHandler = new EditActionHandler(read, persistence, modify, this.appLogger);
            const user = await read.getUserReader().getById(senderId);
            
            if (!user) {
                this.log(LogLevel.ERROR, `User not found: ${senderId}`);
                return false;
            }
            
            // Process the edited response
            await editHandler.processEditedResponse(pendingEditAction.reviewId, user, message.text || '');
            
            // Clean up the action map
            this.deleteAction(pendingEditAction.reviewId);
            
            return true;
        } catch (error) {
            this.log(LogLevel.ERROR, `Error checking for edit response: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * Find a pending edit action for a user
     */
    private findPendingEditAction(userId: string): { reviewId: string, status: string } | null {
        for (const [reviewId, actionData] of this.actionMap.entries()) {
            if (actionData.userId === userId && 
                (actionData.status === 'waiting_for_edit' || actionData.status === 'waiting_for_edit_text')) {
                return { reviewId, status: actionData.status };
            }
        }
        return null;
    }

    /**
     * Updates the action map with user information and status
     */
    private updateActionMap(reviewId: string, userId: string, status: string): void {
        this.actionMap.set(reviewId, { userId, timestamp: Date.now(), status });
        this.log(LogLevel.DEBUG, `Updated action map for review ${reviewId} with status: ${status}`);
    }

    /**
     * Deletes an action from the action map
     */
    private deleteAction(reviewId: string): void {
        this.actionMap.delete(reviewId);
        this.log(LogLevel.DEBUG, `Deleted action for review: ${reviewId}`);
    }

    /**
     * Creates a hash of the content for tracking duplicates
     */
    private createContentHash(content: string): string {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash.toString();
    }

    /**
     * Check if the API configuration is valid
     */
    private checkValidApiConfig(): boolean {
        return !!this.apiConfig && 
               typeof this.apiConfig === 'object' && 
               !!this.apiConfig.apiKey && 
               !!this.apiConfig.endpoint;
    }

    /**
     * Logs a message with the appropriate log level
     */
    private log(level: LogLevel, message: string): void {
        if (this.appLogger) {
            switch (level) {
                case LogLevel.DEBUG:
                    this.appLogger.debug(message);
                    break;
                case LogLevel.INFO:
                    this.appLogger.info(message);
                    break;
                case LogLevel.WARN:
                    this.appLogger.warn(message);
                    break;
                case LogLevel.ERROR:
                    this.appLogger.error(message);
                    break;
            }
        }
    }

    /**
     * Process a message in review mode
     */
    private async processInReviewMode(
        matchResult: any, 
        message: IMessage, 
        read: IRead, 
        persistence: IPersistence, 
        modify: IModify
    ): Promise<void> {
        try {
            this.log(LogLevel.DEBUG, 'Processing in review mode...');
            
            // Check if we have the necessary data
            if (!matchResult || !matchResult.answer || !message.room) {
                this.log(LogLevel.ERROR, 'Missing required data for review');
                return;
            }
            
            // Initialize services
            const reviewManager = new ReviewManager(persistence, read.getPersistenceReader());
            const notificationService = new NotificationService(read, modify);
            
            // Get the sender of the message
            const sender = message.sender;
            if (!sender) {
                this.log(LogLevel.ERROR, 'Message sender not found');
                return;
            }
            
            // Create a new review
            const review = await reviewManager.createReview(
                message,
                message.room,
                sender,
                matchResult.detectedQuestion || 'Unknown question',
                matchResult.answer
            );
            
            // Get reviewers
            const reviewers = await this.getReviewers(read);
            
            if (reviewers.length === 0) {
                this.log(LogLevel.WARN, 'No reviewers found, sending response directly');
                await this.sendResponse(matchResult.answer, message.room.id, modify, read);
                return;
            }
            
            // Send notifications to reviewers
            this.log(LogLevel.DEBUG, `Sending review notifications to ${reviewers.length} reviewers...`);
            
            for (const reviewer of reviewers) {
                try {
                    await notificationService.sendReviewNotification(review, reviewer);
                } catch (error) {
                    this.log(LogLevel.ERROR, `Error sending notification to reviewer ${reviewer.username}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            
            this.log(LogLevel.INFO, `Review ${review.reviewId} created and notifications sent to ${reviewers.length} reviewers`);
            
            // Send a message to the channel that the answer is being reviewed
            const messageBuilder = modify.getCreator().startMessage()
                .setRoom(message.room)
                .setText('🤖 FAQ Bot: Your question has been matched to an FAQ. A reviewer will approve the answer shortly.');
            
            await modify.getCreator().finish(messageBuilder);
        } catch (error) {
            this.log(LogLevel.ERROR, `Error processing in review mode: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    
    /**
     * Get the list of available reviewers
     */
    private async getReviewers(read: IRead): Promise<IUser[]> {
        try {
            const reviewerUsernames = ['admin']; // Replace with actual configuration
            const reviewers: IUser[] = [];
            
            for (const username of reviewerUsernames) {
                const user = await read.getUserReader().getByUsername(username);
                if (user) {
                    reviewers.push(user);
                }
            }
            
            return reviewers;
        } catch (error) {
            this.log(LogLevel.ERROR, `Error getting reviewers: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    /**
     * Send a response to a channel
     */
    private async sendResponse(
        answer: string,
        roomId: string,
        modify: IModify,
        read: IRead
    ): Promise<void> {
        // No need to check for duplicate responses since duplicate detection is disabled
        this.log(LogLevel.DEBUG, `Sending response to room ${roomId} (duplicate detection disabled)`);
        
        try {
            // Get the room
            const room = await read.getRoomReader().getById(roomId);
            if (!room) {
                this.log(LogLevel.ERROR, `Room not found: ${roomId}`);
                return;
            }
            
            // Make sure the answer is not empty
            if (!answer || !answer.trim()) {
                this.log(LogLevel.ERROR, 'Cannot send empty answer');
                return;
            }
            
            // Prefix the message to indicate it's from the bot
            const text = `🤖 FAQ Bot: ${answer}`;
            
            const messageBuilder = modify.getCreator().startMessage()
                .setRoom(room)
                .setText(text);
            
            await modify.getCreator().finish(messageBuilder);
            
            // Record that this response was sent (still record it even though we're not checking)
            const responseHash = this.createContentHash(answer);
            this.processedContents.set(responseHash, Date.now());
            
            this.log(LogLevel.DEBUG, `Response sent to room: ${roomId}`);
        } catch (error) {
            this.log(LogLevel.ERROR, `Error sending response: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
} 