/**
 * #2232 — describing the images embedded in an uploaded document with the project's model.
 *
 * Jira attachments are described this way already (`connectors/jira/attachment-extractor.ts`);
 * the prompt is shared so a wireframe reads the same whichever route brought it in.
 *
 * A description is asked for only when the project's provider reports `vision` for its
 * model (`resolveCapabilities`, catalog-fed); otherwise the describer answers `null` and the
 * converter lists the image as "image not read". The provider is resolved lazily, once per
 * document, and only when the document actually has an image, so a text-only upload never
 * touches the AI configuration.
 */
import type { AIProvider, ChatMessage } from "../ai/types.js";
import { providerSupports } from "../ai/capabilities.js";
import { createChildLogger } from "../logger.js";
import type { ImageDescriber } from "./docx-to-markdown.js";

const log = createChildLogger("image-description");

/** The messages that ask a model to describe one image from a requirements document. */
export function buildImageDescriptionMessages(
  mimeType: string,
  base64: string,
  altText = "",
): ChatMessage[] {
  const alt = altText ? ` The author's alt text for it is: "${altText}".` : "";
  return [
    {
      role: "system",
      content:
        "You are an assistant that describes images found in software requirements documents. " +
        "Extract any visible text, diagrams, tables, flowcharts, wireframes, or specifications. " +
        "Be concise but thorough.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Describe this image in the context of a software requirements document. Extract any visible text, diagrams, tables, or specifications.${alt}`,
        },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
      ],
    },
  ];
}

/** Whether `provider` can be sent an image: a real (not offline) model that reports `vision`. */
export function canDescribeImages(provider: AIProvider): boolean {
  return !provider.offline && providerSupports(provider, "vision", provider.model);
}

/** An {@link ImageDescriber} on `provider`, or one that always answers `null` without vision. */
export function providerImageDescriber(provider: AIProvider): ImageDescriber {
  if (!canDescribeImages(provider)) return async () => null;
  return async (image) => {
    const response = await provider.chat(
      buildImageDescriptionMessages(
        image.contentType,
        image.data.toString("base64"),
        image.altText,
      ),
      { disableTools: true },
    );
    return response.content;
  };
}

/**
 * The describer for one project's document. A provider that cannot be built (no credential,
 * a retired override) is logged and treated as "no vision model": the document still
 * ingests, with its images listed as not read.
 */
export function projectImageDescriber(
  projectId: string,
  // Imported on first use: the provider layer (Prisma, config, adapters) stays out of the
  // module graph of a text-only ingest and of the Jira extractor that shares the prompt.
  resolve: (projectId: string) => Promise<AIProvider> = async (id) =>
    (await import("../ai/project-provider.js")).resolveProjectProvider(id),
): ImageDescriber {
  let describer: Promise<ImageDescriber> | undefined;
  return async (image) => {
    describer ??= resolve(projectId).then(providerImageDescriber, (err: unknown) => {
      log.warn("no provider for image description; images are listed as not read", {
        projectId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return async () => null;
    });
    return (await describer)(image);
  };
}
