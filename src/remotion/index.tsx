/**
 * Director Mode — Remotion Root Entry Point
 * Issue #244: The Remotion bundle entry point that registers all compositions.
 *
 * This file is passed to Remotion's bundle() as the entryPoint.
 * It registers one composition per template, each using the same
 * TemplateComposition component with different defaultProps.
 */

import { Composition } from "remotion";
import { TemplateComposition } from "./compositions/template-composition.js";
import { CompositionInputPropsSchema } from "./input-props.js";
import type { CompositionInputProps } from "./input-props.js";

const defaultProps: CompositionInputProps = {
  templateId: "Minimalist",
  projectTitle: "Untitled Project",
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 300,
  timeline: [],
  audio: { music: null, voiceover: null },
  branding: {
    accentColor: "#3b82f6",
    fontFamily: "Inter, system-ui, sans-serif",
    watermarkOpacity: 0.3,
    watermarkPosition: "bottom-right",
  },
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Minimalist"
        component={TemplateComposition}
        schema={CompositionInputPropsSchema}
        defaultProps={{ ...defaultProps, templateId: "Minimalist" }}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        calculateMetadata={({ props }) => ({
          durationInFrames: props.durationInFrames,
          fps: props.fps,
          width: props.width,
          height: props.height,
        })}
      />
      <Composition
        id="ContentCreator"
        component={TemplateComposition}
        schema={CompositionInputPropsSchema}
        defaultProps={{ ...defaultProps, templateId: "ContentCreator", width: 1080, height: 1920 }}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        calculateMetadata={({ props }) => ({
          durationInFrames: props.durationInFrames,
          fps: props.fps,
          width: props.width,
          height: props.height,
        })}
      />
      <Composition
        id="Corporate"
        component={TemplateComposition}
        schema={CompositionInputPropsSchema}
        defaultProps={{ ...defaultProps, templateId: "Corporate" }}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        calculateMetadata={({ props }) => ({
          durationInFrames: props.durationInFrames,
          fps: props.fps,
          width: props.width,
          height: props.height,
        })}
      />
      <Composition
        id="TechDemo"
        component={TemplateComposition}
        schema={CompositionInputPropsSchema}
        defaultProps={{ ...defaultProps, templateId: "TechDemo" }}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        calculateMetadata={({ props }) => ({
          durationInFrames: props.durationInFrames,
          fps: props.fps,
          width: props.width,
          height: props.height,
        })}
      />
    </>
  );
};
