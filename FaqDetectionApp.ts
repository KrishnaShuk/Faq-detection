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
import { IAppInfo } from '@rocket.chat/apps-engine/definition/metadata';
import { getAPIConfig, settings } from './src/config/settings';
import { IMessage, IPostMessageSent } from '@rocket.chat/apps-engine/definition/messages';
import { faqs } from './src/data/faqs';
import { LLMService } from './src/services/llmService';
import { ReviewManager } from './src/services/ReviewManager';
import { NotificationService } from './src/services/NotificationService';
import { 
    IUIKitInteractionHandler, 
    UIKitActionButtonInteractionContext,
    IUIKitResponse,
    UIKitViewSubmitInteractionContext,
    UIKitBlockInteractionContext,
    UIKitViewCloseInteractionContext
} from '@rocket.chat/apps-engine/definition/uikit';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { ReviewStatus } from './src/data/Review';
import { ApproveActionHandler } from './src/handlers/ApproveActionHandler';
import { RejectActionHandler } from './src/handlers/RejectActionHandler';
import { EditActionHandler } from './src/handlers/EditActionHandler';

export class FaqDetectionApp extends App implements IPostMessageSent, IUIKitInteractionHandler {
    // Track recently processed message IDs and content hashes to avoid duplicates
    private processedMessages: Set<string> = new Set();
    private processedContents: Map<string, number> = new Map();
    private processingLock: boolean = false;
    
    // Map to store review IDs by action IDs
    private reviewActions: Map<string, string> = new Map();
    
    constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
        super(info, logger, accessors);
        logger.debug('FAQ Detection App initialized');
    }

    public async extendConfiguration(
        configuration: IConfigurationExtend
    ): Promise<void> {
        await Promise.all([
            ...settings.map((setting) =>
                configuration.settings.provideSetting(setting)
            ),
        ]);
    }

    async checkPostMessageSent(message: IMessage, read: IRead, http: IHttp): Promise<boolean> {
        this.getLogger().debug('Message received, starting checkPostMessageSent check');
        
        // Skip messages from bots or the app itself
        if (message.sender && (message.sender.type === 'bot' || message.sender.id === 'app')) {
            this.getLogger().debug('Skipping bot or app message');
            return false;
        }

        // Check if the message was sent by this app
        const appUser = await read.getUserReader().getAppUser();
        if (appUser && message.sender && message.sender.id === appUser.id) {
            this.getLogger().debug('Skipping message from this app');
            return false;
        }

        // Get message text
        const text = message.text || '';
        if (text.length === 0) {
            this.getLogger().debug('Skipping empty message');
            return false;
        }

        // Skip messages that start with our bot prefix
        if (text.startsWith('🤖 FAQ Bot:')) {
            this.getLogger().debug('Skipping message with bot prefix');
            return false;
        }

        // *** DUPLICATE DETECTION COMPLETELY DISABLED ***
        // We still record the messages for reference but will process all messages regardless
        const messageId = message.id || '';
        const contentHash = this.hashString(text);
        const uniqueId = `${messageId}:${contentHash}`;
        
        // Record the message but do not check if it's a duplicate
        this.processedMessages.add(uniqueId);
        this.processedContents.set(contentHash, Date.now());
        
        this.getLogger().debug(`Message passed all checks, will be processed: ${uniqueId} (DUPLICATE DETECTION DISABLED)`);
        return true;
    }

    async executePostMessageSent(message: IMessage, read: IRead, http: IHttp, persistence: IPersistence, modify: IModify): Promise<void> {
        try {
            // Set processing lock
            this.processingLock = true;
            
            // Get message text
            const text = message.text || '';
            const messageId = message.id || '';
            const contentHash = this.hashString(text);
            const uniqueId = `${messageId}:${contentHash}`;
            
            // Record message but don't check for duplicates (duplicate detection disabled)
            this.processedMessages.add(uniqueId);
            this.processedContents.set(contentHash, Date.now());
            
            // Keep the sets size manageable
            if (this.processedMessages.size > 100) {
                const iterator = this.processedMessages.values();
                this.processedMessages.delete(iterator.next().value);
            }
            
            this.getLogger().debug(`Processing message: ${uniqueId} (DUPLICATE DETECTION DISABLED)`);
            
            // Get API configuration
            const config = await getAPIConfig(read);
            this.getLogger().debug('API config retrieved:', config);
            
            // Check if API configuration is valid
            if (!config.apiKey || !config.apiEndpoint) {
                this.getLogger().error('API configuration is missing. Please configure API Key and API Endpoint in app settings.');
                this.processingLock = false;
                return;
            }
            
            // Initialize LLM service
            const llmService = new LLMService(http, config.apiKey, config.apiEndpoint, config.modelType);
            
            // Check message against FAQs
            this.getLogger().debug('Checking message against FAQs...');
            const result = await llmService.checkMessage(text, faqs);
            this.getLogger().debug('LLM service result:', result);
            
            // If we found a match, process it according to the review mode setting
            if (result.matched && result.answer) {
                this.getLogger().debug('Found a match, checking review mode...');
                
                // Check if review mode is enabled
                if (config.enableReviewMode && config.reviewerUsernames) {
                    await this.handleReviewMode(
                        message, 
                        result.detectedQuestion || '', 
                        result.answer, 
                        config.reviewerUsernames,
                        read,
                        persistence,
                        modify
                    );
                } else {
                    // Direct response mode (original behavior)
                    this.getLogger().debug('Review mode disabled, sending direct response...');
                    await this.sendResponse(result.answer, message.room, modify);
                    this.getLogger().debug('Response sent successfully');
                }
            } else {
                this.getLogger().debug('No match found or no answer available');
                if (result.error) {
                    this.getLogger().error('Error from LLM service:', result.error);
                }
            }
            
        } catch (error) {
            this.getLogger().error('Error processing message:', error);
            // Send error message to user
            await this.sendResponse('Sorry, I encountered an error while processing your message. Please try again later.', message.room, modify);
        } finally {
            // Release processing lock
            this.processingLock = false;
        }
    }

    /**
     * Handles the review workflow when review mode is enabled
     */
    private async handleReviewMode(
        message: IMessage, 
        detectedQuestion: string,
        proposedAnswer: string,
        reviewerUsernames: string[],
        read: IRead,
        persistence: IPersistence,
        modify: IModify
    ): Promise<void> {
        try {
            this.getLogger().debug('Processing in review mode...');
            
            // Get all reviewer users
            const reviewers = await Promise.all(
                reviewerUsernames.map(async (username) => {
                    const reviewer = await read.getUserReader().getByUsername(username);
                    if (!reviewer) {
                        this.getLogger().error(`Reviewer user not found: ${username}`);
                        return null;
                    }
                    return reviewer;
                })
            );
            
            // Filter out any null reviewers
            const validReviewers = reviewers.filter((reviewer): reviewer is IUser => reviewer !== null);
            
            if (validReviewers.length === 0) {
                this.getLogger().error('No valid reviewers found');
                return;
            }
            
            // Initialize services
            const reviewManager = new ReviewManager(persistence, read.getPersistenceReader());
            const notificationService = new NotificationService(read, modify);
            
            // Create a review record
            const review = await reviewManager.createReview(
                message,
                message.room,
                message.sender,
                detectedQuestion,
                proposedAnswer
            );
            
            this.getLogger().debug(`Created review record: ${review.reviewId}`);
            
            // Store the review ID for action handling
            const approveActionId = `approve_${review.reviewId}`;
            const rejectActionId = `reject_${review.reviewId}`;
            const editActionId = `edit_${review.reviewId}`;
            
            this.reviewActions.set(approveActionId, review.reviewId);
            this.reviewActions.set(rejectActionId, review.reviewId);
            this.reviewActions.set(editActionId, review.reviewId);
            
            // Send notification to all reviewers
            await Promise.all(
                validReviewers.map(reviewer => 
                    notificationService.sendReviewNotification(review, reviewer)
                )
            );
            
            this.getLogger().debug(`Sent review notifications to ${validReviewers.length} reviewers`);
            
        } catch (error) {
            this.getLogger().error('Error in review mode handling:', error);
        }
    }

    /**
     * Handles UI action button interactions (approve/reject)
     */
    public async executeActionButtonInteraction(
        context: UIKitActionButtonInteractionContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify
    ): Promise<IUIKitResponse> {
        const interactionData = context.getInteractionData();
        const actionId = interactionData.actionId;
        const user = interactionData.user;
        
        this.getLogger().debug(`Button interaction received with actionId: ${actionId}`);
        this.getLogger().debug(`Interaction data: ${JSON.stringify(interactionData)}`);
        
        try {
            // Parse the action ID to get the action type and review ID
            let reviewId = '';
            let action = '';
            
            if (actionId.startsWith('approve_')) {
                action = 'approve';
                reviewId = actionId.substring(8); // Remove 'approve_' prefix
                this.getLogger().debug(`Parsed approve action with reviewId: ${reviewId}`);
            } else if (actionId.startsWith('reject_')) {
                action = 'reject';
                reviewId = actionId.substring(7); // Remove 'reject_' prefix
                this.getLogger().debug(`Parsed reject action with reviewId: ${reviewId}`);
            } else if (actionId.startsWith('edit_')) {
                action = 'edit';
                reviewId = actionId.substring(5); // Remove 'edit_' prefix
                this.getLogger().debug(`Parsed edit action with reviewId: ${reviewId}`);
            } else if (actionId.startsWith('submit_edit_')) {
                action = 'submit_edit';
                reviewId = actionId.substring(12); // Remove 'submit_edit_' prefix
                this.getLogger().debug(`Parsed submit_edit action with reviewId: ${reviewId}`);
            } else if (actionId.startsWith('cancel_edit_')) {
                action = 'cancel_edit';
                reviewId = actionId.substring(12); // Remove 'cancel_edit_' prefix
                this.getLogger().debug(`Parsed cancel_edit action with reviewId: ${reviewId}`);
            } else {
                // Try to get the review ID from our map
                reviewId = this.reviewActions.get(actionId) || '';
                this.getLogger().debug(`Looking up reviewId from map for actionId: ${actionId}, found: ${reviewId}`);
                
                if (actionId === 'approve') {
                    action = 'approve';
                } else if (actionId === 'reject') {
                    action = 'reject';
                } else if (actionId === 'edit') {
                    action = 'edit';
                } else if (actionId === 'submit_edit') {
                    action = 'submit_edit';
                } else if (actionId === 'cancel_edit') {
                    action = 'cancel_edit';
                }
            }
            
            if (!reviewId) {
                this.getLogger().error(`No review ID found for action: ${actionId}`);
                return context.getInteractionResponder().errorResponse();
            }
            
            this.getLogger().debug(`Processing ${action} action for review ${reviewId}`);
            
            // Process based on action using dedicated handlers
            if (action === 'approve') {
                this.getLogger().debug(`Creating ApproveActionHandler for reviewId: ${reviewId}`);
                const approveHandler = new ApproveActionHandler(read, persistence, modify, this.getLogger());
                this.getLogger().debug(`Calling handleApproveAction for reviewId: ${reviewId}`);
                await approveHandler.handleApproveAction(reviewId, user);
                this.getLogger().debug(`handleApproveAction completed for reviewId: ${reviewId}`);
            } else if (action === 'reject') {
                this.getLogger().debug(`Creating RejectActionHandler for reviewId: ${reviewId}`);
                const rejectHandler = new RejectActionHandler(read, persistence, modify, this.getLogger());
                this.getLogger().debug(`Calling handleRejectAction for reviewId: ${reviewId}`);
                await rejectHandler.handleRejectAction(reviewId, user);
                this.getLogger().debug(`handleRejectAction completed for reviewId: ${reviewId}`);
            } else if (action === 'edit') {
                this.getLogger().debug(`Creating EditActionHandler for reviewId: ${reviewId}`);
                const editHandler = new EditActionHandler(read, persistence, modify, this.getLogger());
                this.getLogger().debug(`Calling handleEditAction for reviewId: ${reviewId}`);
                await editHandler.handleEditAction(reviewId, user);
                this.getLogger().debug(`handleEditAction completed for reviewId: ${reviewId}`);
            } else if (action === 'submit_edit') {
                this.getLogger().debug(`Creating EditActionHandler for submit_edit with reviewId: ${reviewId}`);
                const editHandler = new EditActionHandler(read, persistence, modify, this.getLogger());
                this.getLogger().debug(`Calling handleSubmitEdit for reviewId: ${reviewId}`);
                await editHandler.handleSubmitEdit(reviewId, user);
                this.getLogger().debug(`handleSubmitEdit completed for reviewId: ${reviewId}`);
            } else if (action === 'cancel_edit') {
                this.getLogger().debug(`Creating EditActionHandler for cancel_edit with reviewId: ${reviewId}`);
                const editHandler = new EditActionHandler(read, persistence, modify, this.getLogger());
                this.getLogger().debug(`Calling handleCancelEdit for reviewId: ${reviewId}`);
                await editHandler.handleCancelEdit(reviewId, user);
                this.getLogger().debug(`handleCancelEdit completed for reviewId: ${reviewId}`);
            }
            
            // Clean up the action map
            this.reviewActions.delete(`approve_${reviewId}`);
            this.reviewActions.delete(`reject_${reviewId}`);
            this.reviewActions.delete(`edit_${reviewId}`);
            this.reviewActions.delete(`submit_edit_${reviewId}`);
            this.reviewActions.delete(`cancel_edit_${reviewId}`);
            this.getLogger().debug(`Cleaned up action map for reviewId: ${reviewId}`);
            
            // Acknowledge the action
            this.getLogger().debug(`Returning success response for actionId: ${actionId}`);
            return context.getInteractionResponder().successResponse();
            
        } catch (error) {
            this.getLogger().error(`Error processing button interaction: ${error instanceof Error ? error.message : String(error)}`);
            this.getLogger().error(`Error stack: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
            return context.getInteractionResponder().errorResponse();
        }
    }

    /**
     * Required by IUIKitInteractionHandler but not used in this app
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
     * Required by IUIKitInteractionHandler but not used in this app
     */
    public async executeBlockActionHandler(
        context: UIKitBlockInteractionContext,
        read: IRead,
        http: IHttp,
        persistence: IPersistence,
        modify: IModify
    ): Promise<IUIKitResponse> {
        const interactionData = context.getInteractionData();
        const actionId = interactionData.actionId;
        const user = interactionData.user;
        
        this.getLogger().debug(`Block action received with actionId: ${actionId}`);
        this.getLogger().debug(`Block interaction data: ${JSON.stringify(interactionData)}`);
        
        try {
            // Parse the action ID to get the action type and review ID
            let reviewId = '';
            let action = '';
            
            if (actionId.startsWith('approve_')) {
                action = 'approve';
                reviewId = actionId.substring(8); // Remove 'approve_' prefix
                this.getLogger().debug(`Parsed approve action with reviewId: ${reviewId} from block handler`);
            } else if (actionId.startsWith('reject_')) {
                action = 'reject';
                reviewId = actionId.substring(7); // Remove 'reject_' prefix
                this.getLogger().debug(`Parsed reject action with reviewId: ${reviewId} from block handler`);
            } else if (actionId.startsWith('edit_')) {
                action = 'edit';
                reviewId = actionId.substring(5); // Remove 'edit_' prefix
                this.getLogger().debug(`Parsed edit action with reviewId: ${reviewId} from block handler`);
            } else if (actionId.startsWith('submit_edit_')) {
                action = 'submit_edit';
                reviewId = actionId.substring(12); // Remove 'submit_edit_' prefix
                this.getLogger().debug(`Parsed submit_edit action with reviewId: ${reviewId} from block handler`);
            } else if (actionId.startsWith('cancel_edit_')) {
                action = 'cancel_edit';
                reviewId = actionId.substring(12); // Remove 'cancel_edit_' prefix
                this.getLogger().debug(`Parsed cancel_edit action with reviewId: ${reviewId} from block handler`);
            } else {
                // Try to get the review ID from our map
                reviewId = this.reviewActions.get(actionId) || '';
                this.getLogger().debug(`Looking up reviewId from map for actionId: ${actionId}, found: ${reviewId} from block handler`);
                
                if (actionId === 'approve') {
                    action = 'approve';
                } else if (actionId === 'reject') {
                    action = 'reject';
                } else if (actionId === 'edit') {
                    action = 'edit';
                } else if (actionId === 'submit_edit') {
                    action = 'submit_edit';
                } else if (actionId === 'cancel_edit') {
                    action = 'cancel_edit';
                }
            }
            
            if (!reviewId) {
                this.getLogger().error(`No review ID found for block action: ${actionId}`);
                return context.getInteractionResponder().errorResponse();
            }
            
            this.getLogger().debug(`Processing ${action} action for review ${reviewId} from block handler`);
            
            // Process based on action using dedicated handlers
            if (action === 'approve') {
                this.getLogger().debug(`Creating ApproveActionHandler for reviewId: ${reviewId} from block handler`);
                const approveHandler = new ApproveActionHandler(read, persistence, modify, this.getLogger());
                this.getLogger().debug(`Calling handleApproveAction for reviewId: ${reviewId} from block handler`);
                await approveHandler.handleApproveAction(reviewId, user);
                this.getLogger().debug(`handleApproveAction completed for reviewId: ${reviewId} from block handler`);
            } else if (action === 'reject') {
                this.getLogger().debug(`Creating RejectActionHandler for reviewId: ${reviewId} from block handler`);
                const rejectHandler = new RejectActionHandler(read, persistence, modify, this.getLogger());
                this.getLogger().debug(`Calling handleRejectAction for reviewId: ${reviewId} from block handler`);
                await rejectHandler.handleRejectAction(reviewId, user);
                this.getLogger().debug(`handleRejectAction completed for reviewId: ${reviewId} from block handler`);
            } else if (action === 'edit') {
                this.getLogger().debug(`Creating EditActionHandler for reviewId: ${reviewId} from block handler`);
                const editHandler = new EditActionHandler(read, persistence, modify, this.getLogger());
                this.getLogger().debug(`Calling handleEditAction for reviewId: ${reviewId} from block handler`);
                await editHandler.handleEditAction(reviewId, user);
                this.getLogger().debug(`handleEditAction completed for reviewId: ${reviewId} from block handler`);
            } else if (action === 'submit_edit') {
                this.getLogger().debug(`Creating EditActionHandler for submit_edit with reviewId: ${reviewId} from block handler`);
                const editHandler = new EditActionHandler(read, persistence, modify, this.getLogger());
                this.getLogger().debug(`Calling handleSubmitEdit for reviewId: ${reviewId} from block handler`);
                await editHandler.handleSubmitEdit(reviewId, user);
                this.getLogger().debug(`handleSubmitEdit completed for reviewId: ${reviewId} from block handler`);
            } else if (action === 'cancel_edit') {
                this.getLogger().debug(`Creating EditActionHandler for cancel_edit with reviewId: ${reviewId} from block handler`);
                const editHandler = new EditActionHandler(read, persistence, modify, this.getLogger());
                this.getLogger().debug(`Calling handleCancelEdit for reviewId: ${reviewId} from block handler`);
                await editHandler.handleCancelEdit(reviewId, user);
                this.getLogger().debug(`handleCancelEdit completed for reviewId: ${reviewId} from block handler`);
            }
            
            // Clean up the action map
            this.reviewActions.delete(`approve_${reviewId}`);
            this.reviewActions.delete(`reject_${reviewId}`);
            this.reviewActions.delete(`edit_${reviewId}`);
            this.reviewActions.delete(`submit_edit_${reviewId}`);
            this.reviewActions.delete(`cancel_edit_${reviewId}`);
            this.getLogger().debug(`Cleaned up action map for reviewId: ${reviewId} from block handler`);
            
            // Acknowledge the action
            this.getLogger().debug(`Returning success response for block actionId: ${actionId}`);
            return context.getInteractionResponder().successResponse();
        } catch (error) {
            this.getLogger().error(`Error processing block action: ${error instanceof Error ? error.message : String(error)}`);
            this.getLogger().error(`Error stack: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
            return context.getInteractionResponder().errorResponse();
        }
    }

    /**
     * Required by IUIKitInteractionHandler but not used in this app
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

    // Simple string hashing function
    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash.toString();
    }

    private async sendResponse(answer: string, room: any, modify: IModify): Promise<void> {
        try {
            // Ensure the answer is not empty
            if (!answer || answer.trim() === '') {
                this.getLogger().debug('Empty answer, not sending response');
                return;
            }
            
            // Create a unique hash for this response
            const responseHash = this.hashString(answer);
            
            // Record but don't check for duplicate responses (duplicate detection disabled)
            this.processedContents.set(responseHash, Date.now());
            
            this.getLogger().debug(`Sending response: ${responseHash} (DUPLICATE DETECTION DISABLED)`);
            
            // Add a prefix to the message to identify it as a response from the app
            const responseText = `🤖 FAQ Bot: ${answer}`;
            
            const messageBuilder = modify.getCreator().startMessage()
                .setRoom(room)
                .setText(responseText);
    
            await modify.getCreator().finish(messageBuilder);
            
            this.getLogger().debug('Response sent successfully');
        } catch (error) {
            this.getLogger().error('Error sending response:', error);
        }
    }
}
