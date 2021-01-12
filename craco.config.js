const { loaderByName, addBeforeLoader } = require("@craco/craco");
module.exports = {
    webpack: {
        alias: {
            "react-dom": "@hot-loader/react-dom"
        },
        configure: (webpackConfig, { env, paths }) => {
            const csvLoader = {
                test: /\.csv$/,
                loader: 'csv-loader',
                options: {
                    header: true,
                    skipEmptyLines: true
                }
            };
            const jsonLoader = {
                test: /\.json$/,
                loader: 'json-loader'
            };

            //addBeforeLoader(webpackConfig, loaderByName("file-loader"), jsonLoader );
            addBeforeLoader(webpackConfig, loaderByName("file-loader"), csvLoader );

            return webpackConfig;
        }
    },
    plugins: [
        { plugin: require("craco-plugin-react-hot-reload") },
        { plugin: require("craco-cesium")() }
    ]
};