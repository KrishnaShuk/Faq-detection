/**
 * Interface representing a review record for FAQ responses
 * This stores information about a detected FAQ and its proposed response
 * that needs to be reviewed before being sent to the original channel
 */
export interface Review {
    /**
     * Unique identifier for this review
     */
    reviewId: string;
    
    /**
     * ID of the original message that triggered the FAQ detection
     */
    messageId: string;
    
    /**
     * ID of the room where the original message was posted
     */
    roomId: string;
    
    /**
     * Type of the room (channel, direct message, etc.)
     */
    roomType: string;
    
    /**
     * Name of the room where the original message was posted
     */
    roomName: string;
    
    /**
     * ID of the user who sent the original message
     */
    senderId: string;
    
    /**
     * Username of the user who sent the original message
     */
    senderUsername: string;
    
    /**
     * The original message text that triggered the FAQ detection
     */
    originalMessage: string;
    
    /**
     * The detected FAQ question that matched the original message
     */
    detectedQuestion: string;
    
    /**
     * The proposed answer to be sent in response
     */
    proposedAnswer: string;
    
    /**
     * Timestamp when this review was created
     */
    timestamp: Date;
    
    /**
     * Current status of the reviewthe possible states of a review:
PENDING: Waiting for reviewer action
APPROVED: Approved and response sent
REJECTED: Rejected with no response sent
EXPIRED: Timed out without action
These changes establish the foundation for the review workflow by:
Providing configuration options to enable/disable the feature and specify the reviewer
Creating a well-defined data structure to store and track review information
The next steps would involve implementing the ReviewManager service to handle storing and retrieving these review records, and the NotificationService to send DMs to the reviewer.
     */
    status: ReviewStatus;
}

/**
 * Possible statuses for a review
 */
export enum ReviewStatus {
    /**
     * Review is waiting for reviewer action
     */
    PENDING = 'pending',
    
    /**
     * Review has been approved and response sent
     */
    APPROVED = 'approved',
    
    /**
     * Review has been rejected and no response sent
     */
    REJECTED = 'rejected',
    
    /**
     * Review has expired due to timeout
     */
    EXPIRED = 'expired'
} 