const HtmlWebpackPlugin = require("html-webpack-plugin");
const { ModuleFederationPlugin } = require("webpack").container;
const dependencies = require("./package.json").dependencies;
const lanMode = process.env.SIGNCONNECT_LAN_MODE === "true";
const lanHost = process.env.SIGNCONNECT_LAN_HOST;
const meetingRemoteUrl = process.env.MEETING_REMOTE_URL || "http://127.0.0.1:3001/remoteEntry.js";

if (lanMode && !lanHost) {
  throw new Error("LAN mode requires SIGNCONNECT_LAN_HOST");
}

module.exports = {
  entry: "./src/index.ts",
  output: {
    publicPath: "auto",
    clean: true,
    uniqueName: "signconnect-shell"
  },
  resolve: {
    extensions: [".tsx", ".ts", ".js"]
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: "ts-loader"
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"]
      }
    ]
  },
  plugins: [
    new ModuleFederationPlugin({
      name: "shell",
      remotes: {
        meeting: `meeting@${meetingRemoteUrl}`
      },
      shared: {
        react: { singleton: true, requiredVersion: dependencies.react },
        "react-dom": { singleton: true, requiredVersion: dependencies["react-dom"] }
      }
    }),
    new HtmlWebpackPlugin({ template: "./public/index.html" })
  ],
  devServer: {
    host: lanMode ? lanHost : "127.0.0.1",
    port: 3000,
    historyApiFallback: true,
    hot: true,
    ...(lanMode ? {
      allowedHosts: [lanHost, "localhost", "127.0.0.1"],
      proxy: [
        {
          context: ["/meeting-assets"],
          target: "http://127.0.0.1:3001",
          pathRewrite: { "^/meeting-assets": "" }
        },
        {
          context: ["/api"],
          target: "http://127.0.0.1:8081"
        },
        {
          context: ["/ws/v1"],
          target: "ws://127.0.0.1:8082",
          ws: true
        }
      ]
    } : {})
  }
};
