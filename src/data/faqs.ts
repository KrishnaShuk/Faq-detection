export interface FAQ {
    question: string;
    answer: string;
}

export const faqs: FAQ[] = [
    {
        question: "How do I start using Rocket.Chat?",
        answer: "To get started with Rocket.Chat:\n1. Download and install Rocket.Chat\n2. Create your workspace\n3. Invite your team members\n4. Start chatting!"
    },
    {
        question: "What are the system requirements?",
        answer: "Rocket.Chat can run on:\n- Windows 10/11\n- macOS 10.14+\n- Linux (Ubuntu 18.04+, Debian 9+, etc.)\n- Mobile devices (iOS 13+, Android 6+)"
    },
    {
        question: "How do I create a channel?",
        answer: "To create a channel:\n1. Click the '+' button in the sidebar\n2. Select 'Channel'\n3. Choose channel type (public/private)\n4. Add channel name and members\n5. Click 'Create'"
    },
    {
        question: "How do I send a message?",
        answer: "To send a message:\n1. Select a channel or direct message\n2. Type your message in the input box\n3. Press Enter or click the send button"
    },
    {
        question: "How do I add emojis?",
        answer: "To add emojis:\n1. Click the emoji button in the message input\n2. Select an emoji from the picker\n3. Or use keyboard shortcuts (e.g., :smile:)"
    }
]; 