#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import Mustache from 'mustache';
import {
  createGmailClient,
  listLabels,
  listUnread,
  getEmail,
  archiveEmail,
  deleteEmail,
  hasOAuthEnv,
} from './lib/gmail.js';

// Load environment variables from a local .env if present (fallback to process defaults)
try {
  const envFile = path.join(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
  } else {
    dotenv.config();
  }
} catch (e) {
  console.error('Failed to load .env file:', e.message);
}

// Debug: Log environment variables
// console.error('Debug - GMAIL_USER:', process.env.GMAIL_USER ? 'Set' : 'Not set');
// console.error('Debug - GMAIL_APP_PASSWORD:', process.env.GMAIL_APP_PASSWORD ? 'Set' : 'Not set');

class GmailMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'gmail-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'send_email',
            description: 'Send an email using Gmail',
            inputSchema: {
              type: 'object',
              properties: {
                to: { type: 'string', description: 'Recipient email address' },
                subject: { type: 'string', description: 'Email subject' },
                body: { type: 'string', description: 'Email body content' },
                html: { type: 'boolean', description: 'Whether the body is HTML', default: false },
              },
              required: ['to', 'subject', 'body'],
            },
          },
          {
            name: 'send_introduction_email',
            description: 'Send a professional introduction email',
            inputSchema: {
              type: 'object',
              properties: {
                to: { type: 'string', description: 'Recipient email address' },
                name: { type: 'string', description: 'Your name', default: 'Yasir Aquil' },
                customMessage: { type: 'string', description: 'Custom message to include' },
              },
              required: ['to'],
            },
          },
          {
            name: 'check_gmail_config',
            description: 'Check if Gmail configuration is properly set up',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'list_labels',
            description: 'List Gmail labels (requires OAuth2 config)',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'list_unread_emails',
            description: 'List recent unread emails (requires OAuth2 config)',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Additional Gmail search query (optional)' },
                maxResults: { type: 'number', description: 'Max number of emails', default: 5 },
              },
            },
          },
          {
            name: 'get_email',
            description: 'Retrieve a full email by ID (requires OAuth2 config)',
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string', description: 'Gmail message ID' } },
              required: ['id'],
            },
          },
          {
            name: 'archive_email',
            description: 'Archive (remove from INBOX) an email by ID (requires OAuth2 config)',
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string', description: 'Gmail message ID' } },
              required: ['id'],
            },
          },
            {
              name: 'delete_email',
              description: 'Move an email to trash by ID (requires OAuth2 config)',
              inputSchema: {
                type: 'object',
                properties: { id: { type: 'string', description: 'Gmail message ID' } },
                required: ['id'],
              },
            },
          {
            name: 'list_email_templates',
            description: 'List available email templates',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'send_template_email',
            description: 'Send an email using a stored template with variables',
            inputSchema: {
              type: 'object',
              properties: {
                to: { type: 'string', description: 'Recipient email address' },
                template: { type: 'string', description: 'Template name (filename without extension)' },
                variables: { type: 'object', description: 'Key-value variables for template interpolation' },
                fallbackSubject: { type: 'string', description: 'Subject if not specified in template' },
              },
              required: ['to', 'template'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'send_email':
            return await this.sendEmail(args);
          case 'send_introduction_email':
            return await this.sendIntroductionEmail(args);
          case 'check_gmail_config':
            return await this.checkGmailConfig();
          case 'list_labels':
            return await this.listLabels();
          case 'list_unread_emails':
            return await this.listUnreadEmails(args);
          case 'get_email':
            return await this.getEmail(args);
          case 'archive_email':
            return await this.archiveEmail(args);
          case 'delete_email':
            return await this.deleteEmail(args);
          case 'list_email_templates':
            return await this.listEmailTemplates();
          case 'send_template_email':
            return await this.sendTemplateEmail(args);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        throw new McpError(ErrorCode.InternalError, `Error executing ${name}: ${error.message}`);
      }
    });
  }

  async createTransporter() {
    console.error('Creating transporter with user:', process.env.GMAIL_USER);
    
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }

  async sendEmail(args) {
    const { to, subject, body, html = false } = args;

    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      throw new Error('Gmail configuration not found. Please check your .env file.');
    }

    const transporter = await this.createTransporter();
    
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: to,
      subject: subject,
      [html ? 'html' : 'text']: body,
    };

    const result = await transporter.sendMail(mailOptions);

    return {
      content: [
        {
          type: 'text',
          text: `Email sent successfully! Message ID: ${result.messageId}`,
        },
      ],
    };
  }

  async sendIntroductionEmail(args) {
    const { to, name = 'Yasir Aquil', customMessage = '' } = args;

    const subject = `Introduction - ${name}`;
    
    const body = `Dear Recipient,

I hope this email finds you well. I'm writing to introduce myself - I'm ${name}, and I wanted to reach out to connect with you.

${customMessage ? customMessage + '\n\n' : ''}I'm a software engineer with experience in various programming technologies including JavaScript, React, and web development. I'm always interested in discussing potential opportunities for collaboration or simply connecting professionally.

Thank you for your time, and I look forward to hearing from you.

Best regards,
${name}
${process.env.GMAIL_USER}`;

    return await this.sendEmail({ to, subject, body });
  }

  async checkGmailConfig() {
    console.error('checkGmailConfig - GMAIL_USER:', process.env.GMAIL_USER);
    console.error('checkGmailConfig - GMAIL_APP_PASSWORD:', process.env.GMAIL_APP_PASSWORD ? '[HIDDEN]' : 'undefined');
    
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      return {
        content: [
          {
            type: 'text',
            text: `Missing environment variables: GMAIL_USER or GMAIL_APP_PASSWORD\n\nPlease check your .env file configuration.`,
          },
        ],
      };
    }

    try {
      const transporter = await this.createTransporter();
      await transporter.verify();
      
      return {
        content: [
          {
            type: 'text',
            text: `Gmail configuration is valid!\nEmail: ${process.env.GMAIL_USER}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Gmail configuration error: ${error.message}`,
          },
        ],
      };
    }
  }

  ensureOAuthAvailable() {
    if (!hasOAuthEnv()) {
      return {
        content: [
          {
            type: 'text',
            text:
              'OAuth2 environment variables missing. Provide GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI, GMAIL_REFRESH_TOKEN to use this tool.',
          },
        ],
      };
    }
    return null;
  }

  async listLabels() {
    const missing = this.ensureOAuthAvailable();
    if (missing) return missing;
    const gmail = createGmailClient();
    const labels = await listLabels(gmail);
    return { content: [{ type: 'text', text: JSON.stringify(labels, null, 2) }] };
  }

  async listUnreadEmails(args) {
    const missing = this.ensureOAuthAvailable();
    if (missing) return missing;
    const gmail = createGmailClient();
    const items = await listUnread(gmail, args || {});
    return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
  }

  async getEmail(args) {
    const missing = this.ensureOAuthAvailable();
    if (missing) return missing;
    const gmail = createGmailClient();
    const data = await getEmail(gmail, args);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  async archiveEmail(args) {
    const missing = this.ensureOAuthAvailable();
    if (missing) return missing;
    const gmail = createGmailClient();
    const result = await archiveEmail(gmail, args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  async deleteEmail(args) {
    const missing = this.ensureOAuthAvailable();
    if (missing) return missing;
    const gmail = createGmailClient();
    const result = await deleteEmail(gmail, args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  templateDir() {
    return path.join(process.cwd(), 'templates');
  }

  async listEmailTemplates() {
    const dir = this.templateDir();
    if (!fs.existsSync(dir)) {
      return { content: [{ type: 'text', text: 'No templates directory found.' }] };
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt'));
    const names = files.map((f) => f.replace(/\.txt$/, ''));
    return { content: [{ type: 'text', text: JSON.stringify(names, null, 2) }] };
  }

  async sendTemplateEmail(args) {
    const { to, template, variables = {}, fallbackSubject } = args;
    const dir = this.templateDir();
    const filePath = path.join(dir, `${template}.txt`);
    if (!fs.existsSync(filePath)) {
      return { content: [{ type: 'text', text: `Template not found: ${template}` }] };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    // Extract subject line if present
    let subject = fallbackSubject || 'No Subject';
    let body = raw;
    const subjectMatch = raw.match(/^Subject:\s*(.*)$/m);
    if (subjectMatch) {
      subject = subjectMatch[1].trim();
      body = raw.replace(subjectMatch[0], '').trim();
    }
    const renderData = { ...variables };
    const renderedSubject = Mustache.render(subject, renderData);
    const renderedBody = Mustache.render(body, renderData);
    return await this.sendEmail({ to, subject: renderedSubject, body: renderedBody });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Gmail MCP Server running on stdio');
  }
}

// Start the server
const server = new GmailMCPServer();
server.run().catch(console.error);
