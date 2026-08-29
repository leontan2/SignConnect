const HtmlWebpackPlugin = require("html-webpack-plugin");
const { ModuleFederationPlugin } = require("webpack").container;
const dependencies = require("./package.json").dependencies;
const meetingRemoteUrl = process.env.MEETING_REMOTE_URL || "http://127.0.0.1:3001/remoteEntry.js";

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
    host: "127.0.0.1",
    port: 3000,
    historyApiFallback: true,
    hot: true
  }
};
