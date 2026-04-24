#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function sanitizeFileName(name) {
    return String(name || 'Untitled')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function yamlEscape(value) {
    return JSON.stringify(String(value ?? ''));
}

function isImageFile(fileName) {
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(fileName || '');
}

function isTelegramPlaceholder(value) {
    return typeof value === 'string' && value.includes('(File not included');
}

function toObsidianLink(fileName) {
    if (!fileName) return '';
    return isImageFile(fileName) ? `![[${fileName}]]` : `[[${fileName}]]`;
}

function applyEntity(part) {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';

    const type = part.type;
    const text = part.text ?? '';
    const href = part.href ?? text;

    switch (type) {
        case 'bold':
            return `**${text}**`;
        case 'italic':
            return `*${text}*`;
        case 'underline':
            return `<u>${text}</u>`;
        case 'strikethrough':
            return `~~${text}~~`;
        case 'code':
            return `\`${text}\``;
        case 'pre': {
            const language = part.language ? part.language + '\n' : '';
            return `\n\n@@@CODEBLOCK_START@@@${language}${text}\n@@@CODEBLOCK_END@@@\n\n`;
        }
        case 'link':
        case 'text_link':
            return `[${text}](${href})`;
        case 'mention': {
            const username = text.startsWith('@') ? text.slice(1) : text;
            return `[${text}](https://t.me/${username})`;
        }
        case 'blockquote':
            return text
                .split('\n')
                .map(line => `> ${line}`)
                .join('\n');
        case 'hashtag':
        case 'bot_command':
        case 'cashtag':
        case 'phone':
        case 'email':
        case 'plain':
        default:
            return text;
    }
}

function finalizeMarkdown(text) {
    return text
        .replace(/@@@CODEBLOCK_START@@@/g, '```')
        .replace(/@@@CODEBLOCK_END@@@/g, '```')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function renderTelegramText(text, textEntities) {
    if (Array.isArray(text)) {
        return finalizeMarkdown(text.map(applyEntity).join(''));
    }

    if (Array.isArray(textEntities) && textEntities.length > 0) {
        return finalizeMarkdown(textEntities.map(applyEntity).join(''));
    }

    if (typeof text === 'string') {
        return finalizeMarkdown(text);
    }

    return '';
}

function buildFileIndex(rootDir) {
    const index = new Map();

    function walk(currentDir) {
        let entries = [];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }

            if (!index.has(entry.name)) {
                index.set(entry.name, fullPath);
            }
        }
    }

    walk(rootDir);
    return index;
}

function findAttachment(rawPath, context) {
    if (!rawPath || isTelegramPlaceholder(rawPath)) return null;

    const normalized = String(rawPath).replaceAll('\\\\', '/');
    const fileName = path.basename(normalized);

    const candidates = [
        path.resolve(context.inputDir, normalized),
        path.resolve(context.exportRootDir, normalized),
        path.resolve(context.inputDir, fileName),
        path.resolve(context.exportRootDir, fileName),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }

    return context.fileIndex.get(fileName) || null;
}

function copyAttachment(rawPath, context) {
    const sourcePath = findAttachment(rawPath, context);
    if (!sourcePath) return null;

    ensureDir(context.attachmentsDir);

    const originalName = path.basename(sourcePath);
    let targetName = originalName;
    let targetPath = path.join(context.attachmentsDir, targetName);
    let counter = 1;

    while (fs.existsSync(targetPath)) {
        const parsed = path.parse(originalName);
        targetName = `${parsed.name}_${counter}${parsed.ext}`;
        targetPath = path.join(context.attachmentsDir, targetName);
        counter += 1;
    }

    fs.copyFileSync(sourcePath, targetPath);
    return targetName;
}

function getAttachmentInfo(msg) {
    const fields = [
        ['photo', 'photo'],
        ['video', 'video'],
        ['voice', 'voice'],
        ['audio', 'audio'],
        ['sticker', 'sticker'],
        ['animation', 'animation'],
        ['file', msg.media_type || 'file'],
    ];

    for (const [field, type] of fields) {
        if (msg[field]) {
            return {
                rawPath: msg[field],
                type,
                fileName: msg.file_name || path.basename(String(msg[field])),
            };
        }
    }

    return null;
}

function formatServiceMessage(msg) {
    const time = String(msg.date || '').slice(11, 19);
    const action = msg.action || 'service';
    const actor = msg.actor || 'Telegram';
    const title = msg.title ? `: ${msg.title}` : '';
    return [
        `### ${time || '00:00:00'} · service`,
        `> [!info] ${actor} — ${action}${title}`,
        '',
        `^tg-${msg.id}`,
        '',
    ].join('\n');
}

function formatRegularMessage(msg, context) {
    const time = String(msg.date || '').slice(11, 19);
    const sender = msg.from || 'Unknown';
    const lines = [`### ${time || '00:00:00'} · ${sender}`];

    if (msg.forwarded_from) {
        lines.push(`> forwarded from: ${msg.forwarded_from}`);
    }

    const body = renderTelegramText(msg.text, msg.text_entities);
    if (body) {
        lines.push('', body);
    }

    const attachment = getAttachmentInfo(msg);
    if (attachment) {
        if (isTelegramPlaceholder(attachment.rawPath)) {
            lines.push('', `_Attachment missing in export: ${attachment.fileName}_`);
        } else {
            const copiedFileName = copyAttachment(attachment.rawPath, context);
            if (copiedFileName) {
                lines.push('', toObsidianLink(copiedFileName));
            } else {
                lines.push('', `_Attachment not found on disk: ${attachment.fileName}_`);
            }
        }
    }

    lines.push('', `^tg-${msg.id}`, '');
    return lines.join('\n');
}

function formatMessage(msg, context) {
    if (msg.type === 'service') {
        return formatServiceMessage(msg);
    }
    return formatRegularMessage(msg, context);
}

function groupMessagesByDay(messages) {
    const groups = new Map();

    for (const msg of messages) {
        const date = String(msg.date || '');
        const day = date.slice(0, 10) || 'unknown-date';
        if (!groups.has(day)) groups.set(day, []);
        groups.get(day).push(msg);
    }

    return groups;
}

function buildFrontmatter(chat, day, messageCount) {
    return [
        '---',
        `chat_name: ${yamlEscape(chat.name)}`,
        `chat_type: ${yamlEscape(chat.type)}`,
        `chat_id: ${chat.id}`,
        `date: ${yamlEscape(day)}`,
        `message_count: ${messageCount}`,
        'tags: [telegram, chat-import]',
        '---',
        '',
    ].join('\n');
}

function buildIndexNote(chat, days) {
    const lines = [
        '---',
        `chat_name: ${yamlEscape(chat.name)}`,
        `chat_type: ${yamlEscape(chat.type)}`,
        `chat_id: ${chat.id}`,
        'tags: [telegram, chat-index]',
        '---',
        '',
        `# ${chat.name}`,
        '',
        `- Type: ${chat.type}`,
        `- Messages: ${chat.messages?.length || 0}`,
        '',
        '## Days',
        '',
    ];

    for (const day of days) {
        lines.push(`- [[${day}]]`);
    }

    lines.push('');
    return lines.join('\n');
}

function convertChat(inputFile, outputRoot) {
    const raw = fs.readFileSync(inputFile, 'utf8');
    const chat = JSON.parse(raw);

    if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) {
        throw new Error('Expected a single chat JSON object with a messages array.');
    }

    const inputDir = path.dirname(path.resolve(inputFile));
    const exportRootDir = inputDir;
    const outputChatDir = path.join(path.resolve(outputRoot), sanitizeFileName(chat.name));
    const attachmentsDir = path.join(outputChatDir, '_attachments');
    ensureDir(outputChatDir);

    const context = {
        inputDir,
        exportRootDir,
        attachmentsDir,
        fileIndex: buildFileIndex(exportRootDir),
    };

    const sortedMessages = [...chat.messages].sort((a, b) => {
        const aTime = new Date(a.date || 0).getTime();
        const bTime = new Date(b.date || 0).getTime();
        if (aTime !== bTime) return aTime - bTime;
        return (a.id || 0) - (b.id || 0);
    });

    const groups = groupMessagesByDay(sortedMessages);
    const days = [...groups.keys()].sort();

    for (const day of days) {
        const dayMessages = groups.get(day);
        const parts = [
            buildFrontmatter(chat, day, dayMessages.length),
            `# ${chat.name} — ${day}`,
            '',
        ];

        for (const msg of dayMessages) {
            parts.push(formatMessage(msg, context));
        }

        const filePath = path.join(outputChatDir, `${day}.md`);
        fs.writeFileSync(filePath, parts.join('\n'), 'utf8');
    }

    const indexPath = path.join(outputChatDir, 'Index.md');
    fs.writeFileSync(indexPath, buildIndexNote(chat, days), 'utf8');

    return {
        chatName: chat.name,
        outputChatDir,
        daysCount: days.length,
        messagesCount: sortedMessages.length,
    };
}

function main() {
    const [, , inputFile, outputDir = './obsidian-out'] = process.argv;

    if (!inputFile) {
        console.error('Usage: node telegram-chat-to-obsidian.js <chat.json> [output-dir]');
        process.exit(1);
    }

    const result = convertChat(inputFile, outputDir);

    console.log('Done');
    console.log(`Chat: ${result.chatName}`);
    console.log(`Days: ${result.daysCount}`);
    console.log(`Messages: ${result.messagesCount}`);
    console.log(`Output: ${result.outputChatDir}`);
}

if (require.main === module) {
    main();
}
