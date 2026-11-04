import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { McpScreen } from "./client/mcp-screen";

function McpItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="PawPrint"
      active={currentScreen?.screenId === "mcp"}
      onPress={() => openScreen({ screenId: "mcp" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "mcp", title: "pasear", Component: McpScreen });
  client.addSidebarHeaderItem({ id: "mcp", title: "pasear", Component: McpItem });
  return () => {};
}
