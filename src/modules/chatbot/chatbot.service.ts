import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec, spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';

import { PrismaService } from '../../database/prisma.service';

/** Storefront aborts its own request at 120s; stay under that so a stalled
 *  sidecar produces a logged server-side error instead of a silent client abort. */
const SIDECAR_CHAT_TIMEOUT_MS = 110000;

/** One short generation off a truncated article — nothing like a chat turn. */
const SIDECAR_SUMMARY_TIMEOUT_MS = 60000;

/** The SEO fields the blog editor can draft from a post's content. */
export const AI_WRITE_KINDS = [
  'summary',
  'meta_description',
  'excerpt',
  'keywords',
] as const;
export type AiWriteKind = (typeof AI_WRITE_KINDS)[number];

/** What to call each one in a message an admin reads. */
const AI_WRITE_LABELS: Record<AiWriteKind, string> = {
  summary: 'summary',
  meta_description: 'meta description',
  excerpt: 'excerpt',
  keywords: 'keywords',
};

@Injectable()
export class ChatbotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatbotService.name);
  private pythonProcess: ChildProcess | null = null;
  private readonly chatbotDir: string;
  private readonly port = 5005;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.chatbotDir = path.resolve(process.cwd(), 'chatbot');
  }

  async onModuleInit() {
    // Never let sidecar problems stop the API from booting.
    try {
      const venvPresent = fs.existsSync(this.pythonExecutable());
      const portResponding = await this.isSidecarResponding();

      if (venvPresent && portResponding) {
        this.logger.log('Python Chatbot Sidecar is already active and healthy.');
        return;
      }

      if (!venvPresent && portResponding) {
        // A sidecar whose virtualenv has been deleted underneath it keeps holding
        // the port and answering this check, while failing every real request.
        // The old port-only probe treated that as "healthy" and never rebuilt it.
        this.logger.warn(
          'Chatbot sidecar is running without its virtualenv (stale process). Retiring it and rebuilding...',
        );
        await this.killOrphanSidecar();
      } else if (!portResponding) {
        this.logger.log(
          `Python Chatbot Sidecar not detected on port ${this.port}. Attempting auto-launch...`,
        );
      }

      const pythonCmd = await this.resolvePythonCommand();
      if (!pythonCmd) {
        this.logger.warn('Python is not installed on server host. Chatbot sidecar will remain disabled.');
        return;
      }

      await this.setupVirtualEnv(pythonCmd);
      this.startPythonApp();

      // Wait briefly for sidecar to boot before treating launch as complete.
      setTimeout(async () => {
        await this.isSidecarResponding();
      }, 3000);
    } catch (setupErr) {
      this.logger.error(
        `Failed to launch Python chatbot sidecar: ${setupErr instanceof Error ? setupErr.message : 'Unknown error'}`,
      );
    }
  }

  private pythonExecutable(): string {
    return process.platform === 'win32'
      ? path.join(this.chatbotDir, '.venv', 'Scripts', 'python.exe')
      : path.join(this.chatbotDir, '.venv', 'bin', 'python');
  }

  private async isSidecarResponding(): Promise<boolean> {
    const apiUrl =
      process.env.CHATBOT_API_URL || `http://127.0.0.1:${this.port}`;
    try {
      await axios.get(`${apiUrl}/health`, { timeout: 1500 });
      return true;
    } catch {
      return false;
    }
  }

  private killOrphanSidecar(): Promise<void> {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        resolve();
        return;
      }
      const mainPy = path.join(this.chatbotDir, 'main.py');
      exec(`pkill -f "${mainPy}"`, () => {
        // Give the OS a moment to release port 5005 before relaunching.
        setTimeout(resolve, 1500);
      });
    });
  }

  onModuleDestroy() {
    if (this.pythonProcess) {
      this.logger.log('Stopping Python chatbot sidecar process...');
      this.pythonProcess.kill();
      this.pythonProcess = null;
    }
  }


  /**
   * Ubuntu images generally ship `python3` with no `python` alias, so probing only
   * `python` reported "Python is not installed" on a host that had it.
   */
  private async resolvePythonCommand(): Promise<string | null> {
    for (const cmd of ['python3', 'python']) {
      const available = await new Promise<boolean>((resolve) => {
        exec(`${cmd} --version`, (err) => resolve(!err));
      });
      if (available) {
        return cmd;
      }
    }
    return null;
  }

  private setupVirtualEnv(pythonCmd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const venvPath = path.join(this.chatbotDir, '.venv');
      const reqPath = path.join(this.chatbotDir, 'requirements.txt');

      // If the interpreter is missing the venv is absent or half-deleted; rebuild it.
      if (!fs.existsSync(this.pythonExecutable())) {
        this.logger.log('Creating Python virtual environment (.venv)...');
        exec(`${pythonCmd} -m venv .venv`, { cwd: this.chatbotDir }, (err) => {
          if (err) {
            return reject(new Error(`Failed to create venv: ${err.message}`));
          }

          this.logger.log(
            'Installing Python dependencies from requirements.txt...',
          );
          const pipPath =
            process.platform === 'win32'
              ? path.join(venvPath, 'Scripts', 'pip.exe')
              : path.join(venvPath, 'bin', 'pip');

          exec(
            `"${pipPath}" install -r "${reqPath}"`,
            { cwd: this.chatbotDir },
            (pipErr) => {
              if (pipErr) {
                return reject(
                  new Error(
                    `Failed to install dependencies: ${pipErr.message}`,
                  ),
                );
              }
              this.logger.log('Python dependencies installed successfully.');
              resolve();
            },
          );
        });
      } else {
        resolve();
      }
    });
  }

  private startPythonApp() {
    const pythonExe = this.pythonExecutable();

    const mainPy = path.join(this.chatbotDir, 'main.py');

    this.logger.log(`Starting FastAPI application via: ${pythonExe}`);

    const geminiApiKey = this.configService.get<string>('GEMINI_API_KEY') || '';

    this.pythonProcess = spawn(pythonExe, [mainPy], {
      cwd: this.chatbotDir,
      env: {
        ...process.env,
        GEMINI_API_KEY: geminiApiKey,
        PORT: this.port.toString(),
      },
      shell: true,
    });

    this.pythonProcess.stdout?.on('data', (data) => {
      this.logger.log(`[Python Stdout] ${data.toString().trim()}`);
    });

    this.pythonProcess.stderr?.on('data', (data) => {
      this.logger.warn(`[Python Stderr] ${data.toString().trim()}`);
    });

    this.pythonProcess.on('close', (code) => {
      this.logger.warn(
        `Python chatbot sidecar process exited with code ${code}`,
      );
      this.pythonProcess = null;
    });
  }

  /**
   * A factual, AI-search-oriented summary of one blog post.
   *
   * Unlike sendMessage this throws rather than degrading: the caller is an
   * admin pressing "Generate", and the result is published verbatim on the
   * post and in llms.txt. A paragraph reading "I encountered an issue" saved
   * as the post's aiSummary and served to crawlers is far worse than an error
   * the admin can see and retry.
   */
  async summarize(input: {
    title?: string;
    content: string;
    maxWords?: number;
  }): Promise<string> {
    return (await this.aiWrite(input)).text;
  }

  /**
   * Draft one SEO field from a post's content: the AI summary, the meta
   * description, the excerpt or the keywords. Each is published somewhere
   * different, so the sidecar asks for each one differently and enforces its
   * own limits — this is a single call rather than four because the article
   * handling, the timeouts and the failure modes are identical.
   */
  async aiWrite(input: {
    title?: string;
    content: string;
    maxWords?: number;
    kind?: AiWriteKind;
  }): Promise<{ text: string; keywords: string[] }> {
    const apiUrl =
      process.env.CHATBOT_API_URL || `http://127.0.0.1:${this.port}`;
    const kind = input.kind ?? 'summary';
    try {
      const response = await axios.post(
        `${apiUrl}/summarize`,
        {
          title: input.title ?? '',
          content: input.content,
          max_words: input.maxWords,
          kind,
        },
        { timeout: SIDECAR_SUMMARY_TIMEOUT_MS },
      );
      // `text` is what the sidecar returns now; `summary` is the field it
      // shipped with, read as a fallback so this works against a sidecar that
      // has not been redeployed yet.
      const raw = response.data?.text ?? response.data?.summary;
      const text = typeof raw === 'string' ? raw.trim() : '';
      const keywords = Array.isArray(response.data?.keywords)
        ? response.data.keywords.filter((k: unknown) => typeof k === 'string')
        : [];
      if (!text) throw new Error(`sidecar returned nothing for ${kind}`);
      return { text, keywords };
    } catch (err) {
      // "Not enough content to summarise" is the admin's problem to fix, not
      // an outage — pass it back as a 400 with the sidecar's own wording.
      const status = err?.response?.status;
      const detail = err?.response?.data?.detail;
      if (status === 400 && typeof detail === 'string') {
        throw new BadRequestException(detail);
      }
      this.logger.error(`AI ${kind} generation failed: ${err.message}`);
      throw new ServiceUnavailableException(
        `Could not write the ${AI_WRITE_LABELS[kind]} right now. Please try again in a moment.`,
      );
    }
  }

  async sendMessage(
    message: string,
    history: Array<{ role: string; content?: string; attachments?: any[] }>,
    attachments?: any[],
    options?: {
      thinkingEnabled?: boolean;
      thinkingBudget?: number;
      /**
       * Compiled by the Studio (persona-compiler.ts). When present the sidecar
       * uses it verbatim instead of assembling its own prompt, so everything an
       * admin configured — voice, boundaries, taught rules — is decided in one
       * place and is testable in TypeScript.
       */
      systemInstruction?: string;
      /** Exactly the tools the admin left switched on. */
      tools?: string[];
      /** Where the customer is on the storefront right now (path + title). */
      pageContext?: string;
    },
  ): Promise<{
    response: string;
    thoughts?: string;
    thinkingTimeMs?: number;
    /** Structured rows from the product tools this turn ran — the widget
     *  renders them as tappable product cards. */
    products?: Array<Record<string, unknown>>;
  }> {
    const geminiApiKey = this.configService.get<string>('GEMINI_API_KEY') || '';

    // We rely on the external Python sidecar process.
    if (!geminiApiKey) {
      this.logger.warn('GEMINI_API_KEY is not set in the environment.');
    }

    try {
      const apiUrl =
        process.env.CHATBOT_API_URL || `http://127.0.0.1:${this.port}`;
      const response = await axios.post(`${apiUrl}/chat`, {
        message,
        history,
        attachments,
        thinking_enabled: options?.thinkingEnabled ?? true,
        thinking_budget: options?.thinkingBudget ?? 2048,
        // Omitted only by callers that predate the Studio; the sidecar then
        // falls back to building the prompt itself, exactly as before.
        system_instruction: options?.systemInstruction,
        tools: options?.tools,
        page_context: options?.pageContext,
      }, {
        // Unbounded before, so a wedged sidecar held the request open forever and
        // the browser was always the first to give up -- the customer got a
        // network error while this process carried on spending Gemini quota on a
        // reply with nowhere to go. Sits just under the storefront's 120s client
        // timeout so the failure surfaces here, as a real error we can log.
        timeout: SIDECAR_CHAT_TIMEOUT_MS,
      });

      const data = response.data;
      if (typeof data === 'string') {
        return { response: data };
      }
      return {
        response: data.response || '',
        thoughts: data.thoughts,
        thinkingTimeMs: data.thinking_time_ms,
        products: Array.isArray(data.products) ? data.products : [],
      };
    } catch (err) {
      this.logger.error(
        `Error communicating with Python chatbot sidecar: ${err.message}`,
      );
      return {
        response: `I'm sorry, I encountered an issue communicating with my AI model. Raw error: ${err.message}`,
      };
    }
  }
}
