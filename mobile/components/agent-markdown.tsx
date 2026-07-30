import { memo } from "react";
import { Linking, StyleSheet } from "react-native";
import Markdown from "react-native-markdown-renderer";
import { colour, radius, space, type } from "../lib/theme";

const markdownStyles = StyleSheet.create({
  root: {
    flexShrink: 1,
  },
  text: {
    color: colour.text,
    fontSize: type.body.fontSize,
    lineHeight: 22,
  },
  paragraph: {
    marginTop: 0,
    marginBottom: space.md,
    flexWrap: "wrap",
    flexDirection: "row",
  },
  strong: {
    color: colour.text,
    fontWeight: "700",
  },
  em: {
    color: colour.text,
    fontStyle: "italic",
  },
  headingContainer: {
    marginTop: space.md,
    marginBottom: space.sm,
  },
  heading: {
    color: colour.text,
    fontWeight: "700",
  },
  heading1: {
    fontSize: 22,
    lineHeight: 28,
  },
  heading1Container: {
    borderBottomWidth: 0,
    paddingBottom: 0,
  },
  heading2: {
    fontSize: 19,
    lineHeight: 25,
  },
  heading2Container: {
    borderBottomWidth: 0,
    paddingBottom: 0,
  },
  heading3: {
    fontSize: 17,
    lineHeight: 23,
  },
  heading4: {
    color: colour.text,
    fontSize: 15,
    lineHeight: 21,
  },
  heading5: {
    color: colour.text,
  },
  heading6: {
    color: colour.textMuted,
  },
  list: {
    marginBottom: space.md,
  },
  listUnorderedItem: {
    marginTop: space.xs,
  },
  listOrderedItem: {
    marginTop: space.xs,
  },
  listUnorderedItemIcon: {
    color: colour.signal,
    lineHeight: 22,
    marginLeft: space.sm,
    marginRight: space.sm,
  },
  listOrderedItemIcon: {
    color: colour.signal,
    lineHeight: 22,
    marginLeft: space.sm,
    marginRight: space.sm,
  },
  listUnorderedItemText: {
    color: colour.text,
    fontSize: type.body.fontSize,
    lineHeight: 22,
  },
  listOrderedItemText: {
    color: colour.text,
    fontSize: type.body.fontSize,
    lineHeight: 22,
  },
  link: {
    color: colour.signal,
    textDecorationLine: "underline",
  },
  codeInline: {
    color: colour.text,
    backgroundColor: colour.cardRaised,
    borderRadius: radius.sm,
    fontFamily: type.mono,
    fontSize: 13,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  codeBlock: {
    color: colour.text,
    backgroundColor: colour.card,
    borderColor: colour.borderStrong,
    borderWidth: 1,
    borderRadius: radius.sm,
    fontFamily: type.mono,
    fontSize: 13,
    lineHeight: 20,
    padding: space.md,
    marginBottom: space.md,
  },
  blockquote: {
    borderLeftColor: colour.signal,
    borderLeftWidth: 3,
    paddingLeft: space.md,
    marginBottom: space.md,
  },
  table: {
    borderColor: colour.borderStrong,
    marginBottom: space.md,
  },
  tableHeader: {
    backgroundColor: colour.cardRaised,
  },
  tableHeaderCell: {
    color: colour.text,
    borderColor: colour.borderStrong,
  },
  tableRow: {
    borderColor: colour.borderStrong,
  },
  tableRowCell: {
    color: colour.text,
    borderColor: colour.borderStrong,
  },
  hr: {
    height: 1,
    backgroundColor: colour.borderStrong,
    marginVertical: space.lg,
  },
  htmlBlock: {
    marginBottom: space.md,
  },
  htmlInline: {
    color: colour.text,
  },
});

async function openLink(url: string): Promise<void> {
  if (!/^(https?:|mailto:)/i.test(url)) return;
  if (await Linking.canOpenURL(url)) await Linking.openURL(url);
}

/**
 * Agent prose is Markdown, not a preformatted log. Keeping this component
 * memoized means a browser frame never makes an already-rendered answer parse
 * again.
 */
export const AgentMarkdown = memo(function AgentMarkdown({ children }: { children: string }) {
  return (
    <Markdown
      style={markdownStyles}
      defaultImageHandler={null}
      onLinkPress={(url) => {
        void openLink(url).catch(() => {});
      }}
    >
      {children}
    </Markdown>
  );
});
