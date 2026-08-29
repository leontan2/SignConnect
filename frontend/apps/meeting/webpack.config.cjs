const HtmlWebpackPlugin = require("html-webpack-plugin");
const webpack = require("webpack");
const { ModuleFederationPlugin } = webpack.container;
const dependencies = require("./package.json").dependencies;

module.exports = {
  entry: "./src/index.ts",
  output: {
    publicPath: "auto",
    clean: true,
    uniqueName: "signconnect-meeting"
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
      name: "meeting",
      filename: "remoteEntry.js",
      exposes: {
        "./MeetingApp": "./src/MeetingApp"
      },
      shared: {
        react: { singleton: true, requiredVersion: dependencies.react },
        "react-dom": { singleton: true, requiredVersion: dependencies["react-dom"] }
      }
    }),
    new webpack.DefinePlugin({
      "process.env.MEETING_API_URL": JSON.stringify(process.env.MEETING_API_URL || "http://localhost:8081"),
      "process.env.REALTIME_WS_URL": JSON.stringify(process.env.REALTIME_WS_URL || "ws://localhost:8082")
    }),
    new HtmlWebpackPlugin({ template: "./public/index.html" })
  ],
  devServer: {
    port: 3001,
    historyApiFallback: true,
    hot: true,
    headers: {
      "Access-Control-Allow-Origin": "*"
    }
  }
};